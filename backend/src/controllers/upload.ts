import sharp from 'sharp'
import { NextFunction, Request, Response } from 'express'
import { constants } from 'http2'
import fs from 'fs/promises'
import BadRequestError from '../errors/bad-request-error'

const MIN_FILE_SIZE_BYTES = 2 * 1024
const MIN_FILE_SIZE_STRICT = MIN_FILE_SIZE_BYTES + 1

export const uploadFile = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (!req.file) {
        return next(new BadRequestError('Файл не загружен'))
    }

    const { file } = req

    try {
        if ((file.size ?? 0) < MIN_FILE_SIZE_STRICT) {
            if (file.path) await fs.unlink(file.path).catch(() => {})
            return next(new BadRequestError('Слишком маленький файл'))
        }

        const meta = await sharp(file.path)
            .metadata()
            .catch(async () => {
                await fs.unlink(file.path).catch(() => {})
                throw new BadRequestError('Некорректное изображение')
            })

        if (!meta || !meta.width || !meta.height) {
            await fs.unlink(req.file.path).catch(() => {})
            return next(new BadRequestError('Некорректное изображение'))
        }

        const base =
            process.env.UPLOAD_PATH || process.env.UPLOAD_PATH_TEMP || ''
        const normalizedBase = base ? `/${base.replace(/^\/+|\/+$/g, '')}` : ''
        const fileName = `${normalizedBase}/${req.file.filename}`

        return res.status(constants.HTTP_STATUS_CREATED).send({
            fileName,
            originalName: req.file.originalname,
        })
    } catch (error) {
        return next(error)
    }
}

export default {}
