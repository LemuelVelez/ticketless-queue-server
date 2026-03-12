import express from "express"
import mongoose from "mongoose"
import dotenv from "dotenv"

import routes from "./routes/Route"
import { notFoundHandler, errorHandler, corsMiddleware } from "./controllers/middlewares"
import { initDefaults } from "./migration/initDefaults"
import {
    getBooleanEnv,
    getEnvOrThrow,
    getMissingOptionalEnv,
    getNumberEnv,
    getServerPublicUrl,
} from "./config/env"

dotenv.config()

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

async function connectDb() {
    const url = getEnvOrThrow("DATABASE_URL")
    const ssl = getBooleanEnv("DATABASE_SSL", false)

    await mongoose.connect(url, ssl ? { tls: true } : {})

    // eslint-disable-next-line no-console
    console.log("✅ MongoDB connected")
}

async function bootstrap() {
    logOptionalEnvWarnings()

    await connectDb()
    await initDefaults()

    const app = express()
    const publicUrl = getServerPublicUrl()

    app.disable("x-powered-by")
    app.set("trust proxy", 1)

    app.use(corsMiddleware)
    app.use(express.json({ limit: "2mb" }))
    app.use(express.urlencoded({ extended: true, limit: "2mb" }))

    app.get("/health", (_req, res) =>
        res.json({
            ok: true,
            service: "QueuePass API",
            publicUrl: publicUrl ?? null,
        })
    )

    app.use("/api", routes)

    app.use(notFoundHandler)
    app.use(errorHandler)

    const port = getNumberEnv("PORT", 3000)
    const server = app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`🚀 Server running on port ${port}`)

        if (publicUrl) {
            // eslint-disable-next-line no-console
            console.log(`🌐 Public URL: ${publicUrl}`)
        }
    })

    const shutdown = async () => {
        // eslint-disable-next-line no-console
        console.log("🛑 Shutting down...")
        server.close()
        await mongoose.connection.close()
        process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
}

bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ Fatal:", err)
    process.exit(1)
})