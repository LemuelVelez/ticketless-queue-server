import { S3Client } from "@aws-sdk/client-s3"
import {
    getEnvOrThrow,
    getNormalizedUrlEnv,
    getOptionalEnv,
    getS3Prefix,
} from "./config/env"

export function getEnvOrThrowFromS3(name: string) {
    return getEnvOrThrow(name)
}

export function getS3BucketName() {
    return getEnvOrThrow("S3_BUCKET_NAME")
}

export function getS3Client() {
    const region = getOptionalEnv("AWS_REGION") ?? "ap-southeast-2"
    const accessKeyId = getEnvOrThrow("AWS_ACCESS_KEY_ID")
    const secretAccessKey = getEnvOrThrow("AWS_SECRET_ACCESS_KEY")

    return new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey },
    })
}

function encodeObjectKey(key: string) {
    return encodeURIComponent(key).replace(/%2F/g, "/")
}

export function normalizeS3Key(key: string) {
    return String(key ?? "")
        .trim()
        .replace(/^\/+/, "")
}

export function buildS3ObjectKey(...parts: Array<string | null | undefined>) {
    const normalizedParts = parts
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .map((part) => part.replace(/^\/+|\/+$/g, ""))

    return normalizedParts.join("/")
}

export function withS3Prefix(key: string) {
    const prefix = getS3Prefix()
    const normalizedKey = normalizeS3Key(key)

    if (!normalizedKey) return prefix
    if (!prefix) return normalizedKey

    return buildS3ObjectKey(prefix, normalizedKey)
}

export function s3ObjectUrl(bucket: string, region: string, key: string) {
    const encodedKey = encodeObjectKey(normalizeS3Key(key))
    const publicBase = getNormalizedUrlEnv("S3_PUBLIC_URL_BASE")

    if (publicBase) {
        return `${publicBase}/${encodedKey}`
    }

    return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`
}

export function resolveStoredFileUrl(value?: string | null) {
    const cleanValue = String(value ?? "").trim()
    if (!cleanValue) return undefined

    if (/^(https?:|data:|blob:)/i.test(cleanValue)) {
        return cleanValue
    }

    const normalizedKey = normalizeS3Key(cleanValue)
    const publicBase = getNormalizedUrlEnv("S3_PUBLIC_URL_BASE")

    if (publicBase) {
        return `${publicBase}/${encodeObjectKey(normalizedKey)}`
    }

    const bucket = getOptionalEnv("S3_BUCKET_NAME")
    const region = getOptionalEnv("AWS_REGION") ?? "ap-southeast-2"

    if (bucket) {
        return s3ObjectUrl(bucket, region, normalizedKey)
    }

    return normalizedKey
}

export function fileExtFromContentType(contentType: string) {
    const ct = contentType.toLowerCase().trim()
    if (ct === "image/jpeg" || ct === "image/jpg") return "jpg"
    if (ct === "image/png") return "png"
    if (ct === "image/webp") return "webp"
    if (ct === "image/gif") return "gif"
    return null
}