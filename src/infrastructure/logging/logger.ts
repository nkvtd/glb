import path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import 'winston-daily-rotate-file';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.resolve(__dirname, '../../../logs');

const { combine, timestamp, errors, splat, json, colorize, printf } =
    winston.format;

const fileFormat = combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    splat(),
    json(),
);

const consoleFormat = combine(
    colorize({ all: false }),
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    splat(),
    printf(({ timestamp, level, message, stack, ...meta }) => {
        const metaString = Object.keys(meta).length
            ? `\n${JSON.stringify(meta, null, 2)}`
            : '';
        const base = `${timestamp} [${level}]: ${message}${metaString}`;
        return stack ? `${base}\n${stack}` : base;
    }),
);

export const logger = winston.createLogger({
    level: 'silly',
    format: fileFormat,
    transports: [
        new winston.transports.Console({
            format: consoleFormat,
        }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '7d',
            zippedArchive: true,
        }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d',
            zippedArchive: true,
        }),
    ],
    exceptionHandlers: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'exceptions-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d',
            zippedArchive: true,
        }),
    ],
    rejectionHandlers: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.DailyRotateFile({
            dirname: logDir,
            filename: 'rejections-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d',
            zippedArchive: true,
        }),
    ],
    exitOnError: false,
});
