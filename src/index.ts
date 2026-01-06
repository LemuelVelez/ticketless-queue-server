import express from "express"
import mongoose from "mongoose"
import dotenv from "dotenv"

import routes from "./routes"
import { notFoundHandler, errorHandler, corsMiddleware } from "./controllers/middlewares"
import { initDefaults } from "./migration/initDefaults"

dotenv.config()

async function connectDb() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is missing")

    const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
    await mongoose.connect(url, ssl ? { tls: true } : {})
    // eslint-disable-next-line no-console
    console.log("✅ MongoDB connected")
}

async function bootstrap() {
    await connectDb()
    await initDefaults()

    const app = express()

    // Basic CORS (no extra dependency)
    app.use(corsMiddleware)

    app.use(express.json({ limit: "2mb" }))

    app.get("/health", (_req, res) => res.json({ ok: true }))

    app.use("/api", routes)

    app.use(notFoundHandler)
    app.use(errorHandler)

    const port = Number(process.env.PORT || 5000)
    const server = app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`🚀 Server running on port ${port}`)
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
