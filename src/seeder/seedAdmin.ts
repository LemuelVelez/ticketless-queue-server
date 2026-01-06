import mongoose from "mongoose"
import dotenv from "dotenv"
import { seedAdminUser } from "./adminSeeder"

dotenv.config()

async function main() {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is missing")

    const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
    await mongoose.connect(url, ssl ? { tls: true } : {})

    // You can override using env:
    // ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
    const email = (process.env.ADMIN_EMAIL || "admin@queuepass.local").trim()
    const password = (process.env.ADMIN_PASSWORD || "Admin@12345").trim()
    const name = (process.env.ADMIN_NAME || "Super Admin").trim()

    const result = await seedAdminUser({ email, password, name })

    // eslint-disable-next-line no-console
    console.log(result.created ? "✅ Admin created" : "ℹ️ Admin already exists", result)

    await mongoose.connection.close()
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("❌ Seeder failed:", err)
    process.exit(1)
})
