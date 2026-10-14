import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, resolveDatabasePath } from './database.js'

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(backendDirectory, '.env') })
const databasePath = resolveDatabasePath(process.env.SQLITE_PATH, backendDirectory)
const database = openDatabase(databasePath)
database.close()
console.log(`Crowzon SQLite schema is ready: ${databasePath}`)
