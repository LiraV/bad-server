import { Request, Express } from 'express'
import multer, { FileFilterCallback } from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

type DestinationCallback = (error: Error | null, destination: string) => void
type FileNameCallback = (error: Error | null, filename: string) => void

const TEMP_DIR = process.env.UPLOAD_PATH_TEMP || 'temp'

const uploadTempDir = path.resolve(__dirname, '..', 'public', TEMP_DIR)

fs.mkdirSync(uploadTempDir, { recursive: true })

const types = new Set([
  'image/png',
  'image/jpg',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
])

const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb: DestinationCallback) => {
    cb(null, uploadTempDir)
  },

  filename: (_req: Request, file: Express.Multer.File, cb: FileNameCallback) => {
    const ext = path.extname(file.originalname).toLowerCase()

    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg'])
    if (!allowedExt.has(ext)) {
      return cb(new Error('Недопустимое расширение'), '')
    }

    const safeName = `${crypto.randomBytes(16).toString('hex')}${ext}`
    cb(null, safeName)
  },
})

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (!types.has(file.mimetype)) return cb(null, false)
  return cb(null, true)
}

export default multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
})