import { NextFunction, Request, Response } from 'express'
import { FilterQuery } from 'mongoose'
import NotFoundError from '../errors/not-found-error'
import BadRequestError from '../errors/bad-request-error'
import Order from '../models/order'
import User, { IUser } from '../models/user'
import escapeRegExp from '../utils/escapeRegExp'

// TODO: Добавить guard admin
// eslint-disable-next-line max-len
// Get GET /customers?page=2&limit=5&sort=totalAmount&order=desc&registrationDateFrom=2023-01-01&registrationDateTo=2023-12-31&lastOrderDateFrom=2023-01-01&lastOrderDateTo=2023-12-31&totalAmountFrom=100&totalAmountTo=1000&orderCountFrom=1&orderCountTo=10

export const getCustomers = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const {
            page = 1,
            limit = 10,
            sortField = 'createdAt',
            sortOrder = 'desc',
            registrationDateFrom,
            registrationDateTo,
            lastOrderDateFrom,
            lastOrderDateTo,
            totalAmountFrom,
            totalAmountTo,
            orderCountFrom,
            orderCountTo,
            search,
        } = req.query

        const MAX_LIMIT = 10

        const safePage =
            Number.isFinite(Number(page)) && Number(page) > 0
                ? Math.floor(Number(page))
                : 1

        const safeLimit =
            Number.isFinite(Number(limit)) && Number(limit) > 0
                ? Math.min(Math.floor(Number(limit)), MAX_LIMIT)
                : 10

        const allowedSortFields = new Set([
            'createdAt',
            'totalAmount',
            'orderCount',
            'lastOrderDate',
            'name',
        ])
        const safeSortField =
            typeof sortField === 'string' && allowedSortFields.has(sortField)
                ? sortField
                : 'createdAt'

        const safeSortOrder =
            sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : 'desc'

        let safeSearch: string | null = null
        if (search !== undefined) {
            if (typeof search !== 'string')
                return next(new BadRequestError('Некорректный search'))
            safeSearch = search.trim()
            if (safeSearch.length > 50)
                return next(new BadRequestError('Слишком длинный search'))
        }

        const filters: FilterQuery<Partial<IUser>> = {}

        if (registrationDateFrom !== undefined) {
            if (typeof registrationDateFrom !== 'string')
                return next(
                    new BadRequestError('Некорректный registrationDateFrom')
                )
            const d = new Date(registrationDateFrom)
            if (Number.isNaN(d.getTime()))
                return next(
                    new BadRequestError('Некорректный registrationDateFrom')
                )
            filters.createdAt = { ...filters.createdAt, $gte: d }
        }

        if (registrationDateTo !== undefined) {
            if (typeof registrationDateTo !== 'string')
                return next(
                    new BadRequestError('Некорректный registrationDateTo')
                )
            const endOfDay = new Date(registrationDateTo)
            if (Number.isNaN(endOfDay.getTime()))
                return next(
                    new BadRequestError('Некорректный registrationDateTo')
                )
            endOfDay.setHours(23, 59, 59, 999)
            filters.createdAt = { ...filters.createdAt, $lte: endOfDay }
        }

        if (lastOrderDateFrom !== undefined) {
            if (typeof lastOrderDateFrom !== 'string')
                return next(
                    new BadRequestError('Некорректный lastOrderDateFrom')
                )
            const d = new Date(lastOrderDateFrom)
            if (Number.isNaN(d.getTime()))
                return next(
                    new BadRequestError('Некорректный lastOrderDateFrom')
                )
            filters.lastOrderDate = { ...filters.lastOrderDate, $gte: d }
        }

        if (lastOrderDateTo !== undefined) {
            if (typeof lastOrderDateTo !== 'string')
                return next(new BadRequestError('Некорректный lastOrderDateTo'))
            const endOfDay = new Date(lastOrderDateTo)
            if (Number.isNaN(endOfDay.getTime()))
                return next(new BadRequestError('Некорректный lastOrderDateTo'))
            endOfDay.setHours(23, 59, 59, 999)
            filters.lastOrderDate = { ...filters.lastOrderDate, $lte: endOfDay }
        }

        if (totalAmountFrom !== undefined) {
            const n = Number(totalAmountFrom)
            if (!Number.isFinite(n))
                return next(new BadRequestError('Некорректный totalAmountFrom'))
            filters.totalAmount = { ...filters.totalAmount, $gte: n }
        }

        if (totalAmountTo !== undefined) {
            const n = Number(totalAmountTo)
            if (!Number.isFinite(n))
                return next(new BadRequestError('Некорректный totalAmountTo'))
            filters.totalAmount = { ...filters.totalAmount, $lte: n }
        }

        if (orderCountFrom !== undefined) {
            const n = Number(orderCountFrom)
            if (!Number.isFinite(n))
                return next(new BadRequestError('Некорректный orderCountFrom'))
            filters.orderCount = { ...filters.orderCount, $gte: n }
        }

        if (orderCountTo !== undefined) {
            const n = Number(orderCountTo)
            if (!Number.isFinite(n))
                return next(new BadRequestError('Некорректный orderCountTo'))
            filters.orderCount = { ...filters.orderCount, $lte: n }
        }

        if (safeSearch) {
            const escaped = escapeRegExp(safeSearch)
            const searchRegex = new RegExp(escaped, 'i')

            const orders = await Order.find(
                { deliveryAddress: searchRegex },
                '_id'
            ).limit(50)
            const orderIds = orders.map((o) => o._id)

            filters.$or = [
                { name: searchRegex },
                { lastOrder: { $in: orderIds } },
            ]
        }

        const sort: Record<string, 1 | -1> = {}
        sort[safeSortField] = safeSortOrder === 'desc' ? -1 : 1

        const options = {
            sort,
            skip: (safePage - 1) * safeLimit,
            limit: safeLimit,
        }

        const users = await User.find(filters, null, options).populate([
            'orders',
            {
                path: 'lastOrder',
                populate: { path: 'products' },
            },
            {
                path: 'lastOrder',
                populate: { path: 'customer' },
            },
        ])

        const totalUsers = await User.countDocuments(filters)
        const totalPages = Math.ceil(totalUsers / safeLimit)

        return res.status(200).json({
            customers: users,
            pagination: {
                totalUsers,
                totalPages,
                currentPage: safePage,
                pageSize: safeLimit,
            },
        })
    } catch (error) {
        return next(error)
    }
}

// TODO: Добавить guard admin
// Get /customers/:id
export const getCustomerById = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const user = await User.findById(req.params.id).populate([
            'orders',
            'lastOrder',
        ])
        res.status(200).json(user)
    } catch (error) {
        next(error)
    }
}

// TODO: Добавить guard admin
// Patch /customers/:id
export const updateCustomer = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            req.body,
            {
                new: true,
            }
        )
            .orFail(
                () =>
                    new NotFoundError(
                        'Пользователь по заданному id отсутствует в базе'
                    )
            )
            .populate(['orders', 'lastOrder'])
        res.status(200).json(updatedUser)
    } catch (error) {
        next(error)
    }
}

// TODO: Добавить guard admin
// Delete /customers/:id
export const deleteCustomer = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id).orFail(
            () =>
                new NotFoundError(
                    'Пользователь по заданному id отсутствует в базе'
                )
        )
        res.status(200).json(deletedUser)
    } catch (error) {
        next(error)
    }
}
