import express from "express"
import mongoose from "mongoose"
import dotenv from "dotenv"

import routes from "./routes/Route"
import {
    notFoundHandler,
    errorHandler,
    corsMiddleware,
} from "./controllers/middlewares"
import { initDefaults } from "./migration/initDefaults"
import {
    getBooleanEnv,
    getEnvOrThrow,
    getMissingOptionalEnv,
    getNumberEnv,
    getServerPublicUrl,
} from "./config/env"

dotenv.config()

const DB_RETRY_DELAY_MS = 5000
const DB_SERVER_SELECTION_TIMEOUT_MS = 10000

function logOptionalEnvWarnings() {
    const missing = getMissingOptionalEnv([
        "CLIENT_ORIGIN",
        "SERVER_PUBLIC_URL",
        "SUPPORT_INBOX",
        "S3_BUCKET_NAME",
        "S3_PUBLIC_URL_BASE",
    ])

    if (!missing.length) return

    // eslint-disable-next-line no-console
    console.warn(`⚠️ Optional env not configured: ${missing.join(", ")}`)
}

function getDbStatus() {
    switch (mongoose.connection.readyState) {
        case 0:
            return "disconnected"
        case 1:
            return "connected"
        case 2:
            return "connecting"
        case 3:
            return "disconnecting"
        default:
            return "unknown"
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectDb() {
    const url = getEnvOrThrow("DATABASE_URL")
    const ssl = getBooleanEnv("DATABASE_SSL", false)

    await mongoose.connect(url, {
        ...(ssl ? { tls: true } : {}),
        serverSelectionTimeoutMS: DB_SERVER_SELECTION_TIMEOUT_MS,
    })

    // eslint-disable-next-line no-console
    console.log("✅ MongoDB connected")
}

let defaultsInitialized = false

async function initDatabaseState() {
    if (defaultsInitialized) return
    await initDefaults()
    defaultsInitialized = true

    // eslint-disable-next-line no-console
    console.log("✅ Default data initialized")
}

async function connectDbInBackground() {
    while (true) {
        try {
            if (mongoose.connection.readyState !== 1) {
                await connectDb()
            }

            await initDatabaseState()
            return
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("❌ MongoDB bootstrap failed:", error)

            if (mongoose.connection.readyState !== 0) {
                try {
                    await mongoose.connection.close()
                } catch {
                    // ignore close errors during retry
                }
            }

            // eslint-disable-next-line no-console
            console.log(
                `🔁 Retrying MongoDB connection in ${
                    DB_RETRY_DELAY_MS / 1000
                }s...`
            )

            await sleep(DB_RETRY_DELAY_MS)
        }
    }
}

async function bootstrap() {
    logOptionalEnvWarnings()

    const app = express()
    const publicUrl = getServerPublicUrl()
    const port = getNumberEnv("PORT", 3000)
    const host = process.env.HOST?.trim() || "0.0.0.0"

    app.disable("x-powered-by")
    app.set("trust proxy", 1)

    app.use(corsMiddleware)
    app.use(express.json({ limit: "2mb" }))
    app.use(express.urlencoded({ extended: true, limit: "2mb" }))

    app.get("/", (_req, res) =>
        res.json({
            ok: true,
            service: "QueuePass API",
            message: "Server is running",
            publicUrl: publicUrl ?? null,
            health: "/health",
            apiBase: "/api",
            db: {
                status: getDbStatus(),
            },
        })
    )

    app.get("/health", (_req, res) => {
        const dbStatus = getDbStatus()
        const ok = dbStatus === "connected"

        res.status(ok ? 200 : 503).json({
            ok,
            service: "QueuePass API",
            publicUrl: publicUrl ?? null,
            db: {
                status: dbStatus,
            },
        })
    })

    app.use("/api", (req, res, next) => {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                ok: false,
                message:
                    "QueuePass API is starting. Database is not connected yet.",
                db: {
                    status: getDbStatus(),
                },
            })
        }

        next()
    })

    app.use("/api", routes)

    app.use(notFoundHandler)
    app.use(errorHandler)

    const server = app.listen(port, host, () => {
        // eslint-disable-next-line no-console
        console.log(`🚀 Server running on ${host}:${port}`)
        // eslint-disable-next-line no-console
        console.log(`🏠 Local URL: http://localhost:${port}`)

        if (publicUrl) {
            // eslint-disable-next-line no-console
            console.log(`🌐 Public URL: ${publicUrl}`)
        }
    })

    void connectDbInBackground()

    const shutdown = async (signal: string) => {
        // eslint-disable-next-line no-console
        console.log(`🛑 ${signal} received. Shutting down...`)

        await new Promise<void>((resolve, reject) => {
            server.close((err) => {
                if (err) return reject(err)
                resolve()
            })
        })

        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close()
        }

        process.exit(0)
    }

    process.on("SIGINT", () => {
        void shutdown("SIGINT")
    })

    process.on("SIGTERM", () => {
        void shutdown("SIGTERM")
    })
}

bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ Fatal:", err)
    process.exit(1)
})