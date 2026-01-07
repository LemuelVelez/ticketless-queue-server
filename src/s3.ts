import { S3Client } from "@aws-sdk/client-s3"

export function getEnvOrThrow(name: string) {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is missing`)
    return v
}

export function getS3Client() {
    const region = getEnvOrThrow("AWS_REGION")
    const accessKeyId = getEnvOrThrow("AWS_ACCESS_KEY_ID")
    const secretAccessKey = getEnvOrThrow("AWS_SECRET_ACCESS_KEY")

    return new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey },
    })
}

export function s3ObjectUrl(bucket: string, region: string, key: string) {
    // Standard virtual-hosted–style URL
    return `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, "/")}`
}

export function fileExtFromContentType(contentType: string) {
    const ct = contentType.toLowerCase().trim()
    if (ct === "image/jpeg" || ct === "image/jpg") return "jpg"
    if (ct === "image/png") return "png"
    if (ct === "image/webp") return "webp"
    if (ct === "image/gif") return "gif"
    return null
}
