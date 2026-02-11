import { NextFunction, Request, Response } from 'express'
import { FilterQuery, Error as MongooseError, Types } from 'mongoose'
import BadRequestError from '../errors/bad-request-error'
import NotFoundError from '../errors/not-found-error'
import Order, { IOrder } from '../models/order'
import Product, { IProduct } from '../models/product'
import User from '../models/user'
import sanitizeHtml from 'sanitize-html'
import escapeRegExp from '../utils/escapeRegExp'

// eslint-disable-next-line max-len
// GET /orders?page=2&limit=5&sort=totalAmount&order=desc&orderDateFrom=2024-07-01&orderDateTo=2024-08-01&status=delivering&totalAmountFrom=100&totalAmountTo=1000&search=%2B1

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortField = 'createdAt',
      sortOrder = 'desc',
      status,
      totalAmountFrom,
      totalAmountTo,
      orderDateFrom,
      orderDateTo,
      search,
    } = req.query;

    const MAX_LIMIT = 10;

    const safePage =
      Number.isFinite(Number(page)) && Number(page) > 0 ? Math.floor(Number(page)) : 1;

    const safeLimit =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.min(Math.floor(Number(limit)), MAX_LIMIT)
        : 10;

    const allowedSortFields = new Set(['createdAt', 'totalAmount', 'orderNumber', 'status']);
    const safeSortField =
      typeof sortField === 'string' && allowedSortFields.has(sortField) ? sortField : 'createdAt';

    const safeSortOrder = sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : 'desc';

    let safeSearch: string | null = null;
    if (search !== undefined) {
      if (typeof search !== 'string') return next(new BadRequestError('Некорректный search'));
      safeSearch = search.trim();
      if (safeSearch.length > 50) return next(new BadRequestError('Слишком длинный search'));
    }

    const filters: FilterQuery<Partial<IOrder>> = {};
    const allowedStatuses = ['completed', 'pending', 'created', 'cancelled'] as const;

    if (status !== undefined) {
      if (typeof status !== 'string') return next(new BadRequestError('Некорректный status'));
      if (!allowedStatuses.includes(status as any)) {
        return next(new BadRequestError('Некорректный status'));
      }
      filters.status = status;
    }

    if (totalAmountFrom !== undefined) {
      const n = Number(totalAmountFrom);
      if (!Number.isFinite(n)) return next(new BadRequestError('Некорректный totalAmountFrom'));
      filters.totalAmount = { ...filters.totalAmount, $gte: n };
    }

    if (totalAmountTo !== undefined) {
      const n = Number(totalAmountTo);
      if (!Number.isFinite(n)) return next(new BadRequestError('Некорректный totalAmountTo'));
      filters.totalAmount = { ...filters.totalAmount, $lte: n };
    }

    if (orderDateFrom !== undefined) {
      if (typeof orderDateFrom !== 'string') return next(new BadRequestError('Некорректный orderDateFrom'));
      const d = new Date(orderDateFrom);
      if (Number.isNaN(d.getTime())) return next(new BadRequestError('Некорректный orderDateFrom'));
      filters.createdAt = { ...filters.createdAt, $gte: d };
    }

    if (orderDateTo !== undefined) {
      if (typeof orderDateTo !== 'string') return next(new BadRequestError('Некорректный orderDateTo'));
      const d = new Date(orderDateTo);
      if (Number.isNaN(d.getTime())) return next(new BadRequestError('Некорректный orderDateTo'));
      filters.createdAt = { ...filters.createdAt, $lte: d };
    }

    const sort: Record<string, 1 | -1> = {};
    sort[safeSortField] = safeSortOrder === 'desc' ? -1 : 1;

    // База pipeline (без пагинации/сорта/группировки — чтобы легко собрать count)
    const basePipeline: any[] = [
      { $match: filters },
      {
        $lookup: {
          from: 'products',
          localField: 'products',
          foreignField: '_id',
          as: 'products',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'customer',
          foreignField: '_id',
          as: 'customer',
        },
      },
      { $unwind: '$customer' },
      { $unwind: '$products' },
    ];

    if (safeSearch) {
      const escaped = escapeRegExp(safeSearch);
      const searchRegex = new RegExp(escaped, 'i');
      const searchNumber = Number(safeSearch);

      const searchConditions: any[] = [{ 'products.title': searchRegex }];
      if (!Number.isNaN(searchNumber)) {
        searchConditions.push({ orderNumber: searchNumber });
      }

      basePipeline.push({ $match: { $or: searchConditions } });
    }

    const dataPipeline = basePipeline.concat([
      { $sort: sort },
      { $skip: (safePage - 1) * safeLimit },
      { $limit: safeLimit },
      {
        $group: {
          _id: '$_id',
          orderNumber: { $first: '$orderNumber' },
          status: { $first: '$status' },
          totalAmount: { $first: '$totalAmount' },
          products: { $push: '$products' },
          customer: { $first: '$customer' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]);

    const countPipeline = basePipeline.concat([{ $group: { _id: '$_id' } }, { $count: 'total' }]);

    const [orders, totalAgg] = await Promise.all([
      Order.aggregate(dataPipeline),
      Order.aggregate(countPipeline),
    ]);

    const totalOrders = totalAgg?.[0]?.total ?? 0;
    const totalPages = Math.ceil(totalOrders / safeLimit);

    return res.status(200).json({
      orders,
      pagination: {
        totalOrders,
        totalPages,
        currentPage: safePage,
        pageSize: safeLimit,
      },
    });
  } catch (error) {
    return next(error);
  }
};

export const getOrdersCurrentUser = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const userId = res.locals.user._id
        const { search, page = 1, limit = 5 } = req.query
        const options = {
            skip: (Number(page) - 1) * Number(limit),
            limit: Number(limit),
        }

        const user = await User.findById(userId)
            .populate({
                path: 'orders',
                populate: [
                    {
                        path: 'products',
                    },
                    {
                        path: 'customer',
                    },
                ],
            })
            .orFail(
                () =>
                    new NotFoundError(
                        'Пользователь по заданному id отсутствует в базе'
                    )
            )

        let orders = user.orders as unknown as IOrder[]

        if (search) {
            // если не экранировать то получаем Invalid regular expression: /+1/i: Nothing to repeat
            const searchRegex = new RegExp(search as string, 'i')
            const searchNumber = Number(search)
            const products = await Product.find({ title: searchRegex })
            const productIds = products.map((product) => product._id)

            orders = orders.filter((order) => {
                // eslint-disable-next-line max-len
                const matchesProductTitle = order.products.some((product) =>
                    productIds.some((id) => id.equals(product._id))
                )
                // eslint-disable-next-line max-len
                const matchesOrderNumber =
                    !Number.isNaN(searchNumber) &&
                    order.orderNumber === searchNumber

                return matchesOrderNumber || matchesProductTitle
            })
        }

        const totalOrders = orders.length
        const totalPages = Math.ceil(totalOrders / Number(limit))

        orders = orders.slice(options.skip, options.skip + options.limit)

        return res.send({
            orders,
            pagination: {
                totalOrders,
                totalPages,
                currentPage: Number(page),
                pageSize: Number(limit),
            },
        })
    } catch (error) {
        next(error)
    }
}

// Get order by ID
export const getOrderByNumber = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const order = await Order.findOne({
            orderNumber: req.params.orderNumber,
        })
            .populate(['customer', 'products'])
            .orFail(
                () =>
                    new NotFoundError(
                        'Заказ по заданному id отсутствует в базе'
                    )
            )
        return res.status(200).json(order)
    } catch (error) {
        if (error instanceof MongooseError.CastError) {
            return next(new BadRequestError('Передан не валидный ID заказа'))
        }
        return next(error)
    }
}

export const getOrderCurrentUserByNumber = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const userId = res.locals.user._id
    try {
        const order = await Order.findOne({
            orderNumber: req.params.orderNumber,
        })
            .populate(['customer', 'products'])
            .orFail(
                () =>
                    new NotFoundError(
                        'Заказ по заданному id отсутствует в базе'
                    )
            )
        if (!order.customer._id.equals(userId)) {
            // Если нет доступа не возвращаем 403, а отдаем 404
            return next(
                new NotFoundError('Заказ по заданному id отсутствует в базе')
            )
        }
        return res.status(200).json(order)
    } catch (error) {
        if (error instanceof MongooseError.CastError) {
            return next(new BadRequestError('Передан не валидный ID заказа'))
        }
        return next(error)
    }
}

// POST /product
export const createOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.user._id;
    const MAX_ITEMS = 50;
    const { address, payment, phone, total, email, items, comment } = req.body;

    if (!Array.isArray(items)) {
  return next(new BadRequestError('items должен быть массивом'));
}

if (items.length === 0 || items.length > MAX_ITEMS) {
  return next(new BadRequestError(`Некорректное количество товаров (1-${MAX_ITEMS})`));
}

    if (typeof phone !== 'string') {
      return next(new BadRequestError('Телефон должен быть строкой'));
    }

    const normalizedPhone = phone.trim();

    if (normalizedPhone.length > 20) {
      return next(new BadRequestError('Слишком длинный телефон'));
    }

    if (!/^\+?\d{10,15}$/.test(normalizedPhone)) {
      return next(new BadRequestError('Некорректный телефон'));
    }

    const basket: IProduct[] = [];
    const products = await Product.find({ _id: { $in: items } });
    if (products.length !== items.length) throw new BadRequestError('Товар не найден');

    items.forEach((id: Types.ObjectId) => {
      const product = products.find((p) => p._id.equals(id));
      if (!product) throw new BadRequestError(`Товар с id ${id} не найден`);
      if (product.price === null) throw new BadRequestError(`Товар с id ${id} не продается`);
      basket.push(product);
    });

    const totalBasket = basket.reduce((a, c) => a + c.price, 0);
    if (totalBasket !== total) {
      return next(new BadRequestError('Неверная сумма заказа'));
    }

    const safeComment = sanitizeHtml(comment || '', { allowedTags: [], allowedAttributes: {} });

    const newOrder = new Order({
      totalAmount: total,
      products: items,
      payment,
      phone: normalizedPhone,
      email,
      comment: safeComment,
      customer: userId,
      deliveryAddress: address,
    });

    const populateOrder = await newOrder.populate(['customer', 'products']);
    await populateOrder.save();

    return res.status(200).json(populateOrder);
  } catch (error) {
    if (error instanceof MongooseError.ValidationError) {
      return next(new BadRequestError(error.message));
    }
    return next(error);
  }
};

// Update an order
export const updateOrder = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const { status } = req.body
        const updatedOrder = await Order.findOneAndUpdate(
            { orderNumber: req.params.orderNumber },
            { status },
            { new: true, runValidators: true }
        )
            .orFail(
                () =>
                    new NotFoundError(
                        'Заказ по заданному id отсутствует в базе'
                    )
            )
            .populate(['customer', 'products'])
        return res.status(200).json(updatedOrder)
    } catch (error) {
        if (error instanceof MongooseError.ValidationError) {
            return next(new BadRequestError(error.message))
        }
        if (error instanceof MongooseError.CastError) {
            return next(new BadRequestError('Передан не валидный ID заказа'))
        }
        return next(error)
    }
}

// Delete an order
export const deleteOrder = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id)
            .orFail(
                () =>
                    new NotFoundError(
                        'Заказ по заданному id отсутствует в базе'
                    )
            )
            .populate(['customer', 'products'])
        return res.status(200).json(deletedOrder)
    } catch (error) {
        if (error instanceof MongooseError.CastError) {
            return next(new BadRequestError('Передан не валидный ID заказа'))
        }
        return next(error)
    }
}
