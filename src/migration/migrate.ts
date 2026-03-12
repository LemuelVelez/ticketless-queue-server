import mongoose from "mongoose"
import dotenv from "dotenv"

import {
    AuditLogModel,
    DepartmentModel,
    QueueCounterModel,
    ServiceWindowModel,
    SettingModel,
    TicketModel,
    UserModel,
} from "../models/Model"
import { initDefaults } from "./initDefaults"

dotenv.config()

async function connectDb() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is missing")

    const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
    await mongoose.connect(url, ssl ? { tls: true } : {})
    // eslint-disable-next-line no-console
    console.log("✅ MongoDB connected")
}

/**
 * Creates the MongoDB collection if it doesn't exist (safe / idempotent).
 */
async function ensureCollection(model: mongoose.Model<any>) {
    const db = mongoose.connection.db
    const name = model.collection.name

    const exists = await db.listCollections({ name }).hasNext()
    if (!exists) {
        await db.createCollection(name)
        // eslint-disable-next-line no-console
        console.log(`✅ Created collection: ${name}`)
    } else {
        // eslint-disable-next-line no-console
        console.log(`ℹ️ Collection already exists: ${name}`)
    }
}

/**
 * Ensures all collections + indexes exist.
 * Uses createIndexes() (creates missing indexes, does NOT drop extra ones).
 */
async function ensureCollectionsAndIndexes() {
    const models: Array<mongoose.Model<any>> = [
        UserModel,
        DepartmentModel,
        ServiceWindowModel,
        TicketModel,
        QueueCounterModel,
        SettingModel,
        AuditLogModel,
    ]

    for (const model of models) {
        await ensureCollection(model)

        // Build indexes defined on schema (safe to re-run; creates missing ones)
        await model.createIndexes()

        // eslint-disable-next-line no-console
        console.log(`✅ Ensured indexes: ${model.collection.name}`)
    }
}

async function main() {
    await connectDb()

    // Create collections + indexes
    await ensureCollectionsAndIndexes()

    // Optional defaults (kept consistent with your app behavior)
    await initDefaults()

    // eslint-disable-next-line no-console
    console.log("🚀 Migration complete")

    await mongoose.connection.close()
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ Migration failed:", err)
    process.exit(1)
})