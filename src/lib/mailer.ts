import nodemailer from "nodemailer"
import * as fs from "fs"
import * as path from "path"
import { buildSendLoginCredentialsEmail } from "./email-templates/send-login-credentials"

function getTransporter() {
    const user = process.env.GMAIL_USER
    const pass = process.env.GMAIL_APP_PASSWORD

    if (!user || !pass) return null

    return nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
    })
}

function escapeHtml(input: string) {
    return input
        .split("&").join("&amp;")
        .split("<").join("&lt;")
        .split(">").join("&gt;")
        .split('"').join("&quot;")
        .split("'").join("&#039;")
}

function buildResetLinkFromClientOrigin(token: string) {
    const originRaw = process.env.CLIENT_ORIGIN
    if (!originRaw) return null

    const origin = originRaw.replace(/\/$/, "")
    return `${origin}/reset-password?token=${encodeURIComponent(token)}`
}

function buildLoginLinkFromClientOrigin() {
    const originRaw = process.env.CLIENT_ORIGIN
    if (!originRaw) return null
    const origin = originRaw.replace(/\/$/, "")
    return `${origin}/login`
}

/**
 * Theme conversion from src/index.css (OKLCH -> HEX) approximations:
 */
const THEME = {
    background: "#FFFFFF",
    foreground: "#0C0A09",
    primary: "#008D87",
    primaryForeground: "#FAFAF9",
    secondary: "#E5F8F6",
    muted: "#EFF7F6",
    mutedForeground: "#576766",
    border: "#E7E5E4",
    ring: "#18A7A1",
}

// ✅ Gmail tends to be more reliable when CID includes "@"
const LOGO_PNG_CID = "queuepass-logo@queuepass.local"

function findLogoPngPath(): string | null {
    const candidates = [
        path.join(process.cwd(), "src", "images", "logo.png"),
        path.join(process.cwd(), "dist", "images", "logo.png"),
        path.join(process.cwd(), "build", "images", "logo.png"),
        path.join(__dirname, "..", "images", "logo.png"),
        path.join(__dirname, "..", "..", "images", "logo.png"),
        path.join(__dirname, "..", "..", "..", "images", "logo.png"),
    ]

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p
        } catch {
            // ignore
        }
    }
    return null
}

function getInlineLogoAttachment(): { filename: string; content: Buffer; cid: string; contentType: string } | null {
    const logoPngPath = findLogoPngPath()
    if (!logoPngPath) return null

    try {
        const content = fs.readFileSync(logoPngPath)
        if (!content || content.length === 0) return null

        return {
            filename: "logo.png",
            content,
            cid: LOGO_PNG_CID,
            contentType: "image/png",
        }
    } catch {
        return null
    }
}

export async function sendPasswordResetEmail(opts: {
    to: string
    name?: string
    resetLink?: string
    token: string
    expiresMinutes: number
}) {
    const transporter = getTransporter()
    if (!transporter) {
        throw new Error("Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.")
    }

    const fromUser = process.env.GMAIL_USER!
    const subject = "Reset your QueuePass password"

    const safeName = opts.name ? escapeHtml(opts.name.trim()) : ""
    const greeting = safeName ? `Hi ${safeName},` : "Hi,"

    const resetLink = buildResetLinkFromClientOrigin(opts.token) ?? opts.resetLink ?? null

    const text = [
        opts.name ? `Hi ${opts.name.trim()},` : "Hi,",
        "",
        "We received a request to reset your QueuePass password.",
        "",
        resetLink ? `Reset link: ${resetLink}` : "Reset link: (CLIENT_ORIGIN not configured)",
        "",
        `This link expires in ${opts.expiresMinutes} minutes.`,
        "If you did not request this, you can ignore this email.",
        "",
        "— QueuePass",
    ].join("\n")

    const year = new Date().getFullYear()
    const logoAttachment = getInlineLogoAttachment()

    /**
     * ✅ Fix “cramped / not balanced” logo:
     * - Give the logo container padding
     * - Make the image fill the padded area with object-fit: cover
     * - Center the crop using object-position: center
     */
    const logoInnerHtml = logoAttachment
        ? `<img src="cid:${LOGO_PNG_CID}" alt="QueuePass logo"
              style="display:block;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:10px;" />`
        : `<div
              style="width:100%;height:100%;border-radius:10px;border:1px solid ${THEME.border};background:${THEME.background};
                     font-family:Arial, sans-serif;font-weight:800;font-size:12px;color:${THEME.foreground};
                     display:block;line-height:36px;text-align:center;">
              QP
           </div>`

    const html = `
<div style="margin:0;padding:0;background:${THEME.muted};width:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Reset your QueuePass password
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
    style="background:${THEME.muted};padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

          <!-- Header -->
          <tr>
            <td style="padding:0 0 14px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                style="border:1px solid ${THEME.border};background:${THEME.background};border-radius:18px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td width="46" valign="middle" style="padding-right:12px;">
                          <!-- ✅ Outer logo container -->
                          <div style="width:46px;height:46px;border-radius:14px;border:1px solid ${THEME.border};
                                      background:${THEME.background};overflow:hidden;padding:4px;box-sizing:border-box;">
                            <!-- ✅ Inner area (46 - 8 padding = 38px square) -->
                            <div style="width:38px;height:38px;">
                              ${logoInnerHtml}
                            </div>
                          </div>
                        </td>

                        <td valign="middle" style="font-family:Arial, sans-serif;">
                          <div style="font-size:14px;font-weight:800;color:${THEME.foreground};line-height:1.2;">
                            QueuePass
                          </div>
                          <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.2;">
                            Ticketless QR Queue
                          </div>
                        </td>

                        <td align="right" valign="middle" style="font-family:Arial, sans-serif;">
                          <div style="font-size:12px;color:${THEME.mutedForeground};">
                            Password Reset
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                style="border:1px solid ${THEME.border};background:${THEME.background};border-radius:18px;">
                <tr>
                  <td style="padding:20px 18px 18px 18px;font-family:Arial, sans-serif;color:${THEME.foreground};">

                    <div style="font-size:20px;font-weight:900;letter-spacing:-0.2px;margin:0 0 6px 0;">
                      Reset your password
                    </div>
                    <div style="font-size:13px;color:${THEME.mutedForeground};margin:0 0 16px 0;line-height:1.5;">
                      We received a request to reset your QueuePass password.
                    </div>

                    <div style="font-size:14px;line-height:1.6;margin:0 0 14px 0;">
                      ${greeting}
                    </div>

                    ${resetLink
            ? `
                    <div style="margin:0 0 14px 0;">
                      <a href="${resetLink}"
                         style="display:inline-block;background:${THEME.primary};color:${THEME.primaryForeground};
                                text-decoration:none;padding:12px 14px;border-radius:14px;font-size:14px;font-weight:800;">
                        Reset Password
                      </a>
                    </div>

                    <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.5;margin:0 0 14px 0;">
                      If the button doesn’t work, copy and paste this link:
                      <div style="margin-top:8px;padding:10px 12px;border-radius:14px;background:${THEME.secondary};
                                  border:1px solid ${THEME.border};word-break:break-all;
                                  font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace;
                                  font-size:12px;color:${THEME.foreground};">
                        ${resetLink}
                      </div>
                    </div>
                            `
            : `
                    <div style="margin:0 0 14px 0;padding:12px 12px;border-radius:14px;background:${THEME.secondary};
                                border:1px solid ${THEME.border};color:${THEME.mutedForeground};font-size:13px;line-height:1.5;">
                      CLIENT_ORIGIN is not configured, so a reset link cannot be generated.
                    </div>
                            `
        }

                    <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.5;margin:0 0 6px 0;">
                      This link expires in <b style="color:${THEME.foreground};">${opts.expiresMinutes} minutes</b>.
                    </div>

                    <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.5;margin:0;">
                      If you did not request this, you can safely ignore this email.
                    </div>

                  </td>
                </tr>

                <tr>
                  <td style="padding:14px 18px;border-top:1px solid ${THEME.border};background:${THEME.background};border-radius:0 0 18px 18px;">
                    <div style="font-family:Arial, sans-serif;font-size:12px;color:${THEME.mutedForeground};line-height:1.5;">
                      For security reasons, please do not share your password with anyone.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:14px 6px 0 6px;">
              <div style="font-family:Arial, sans-serif;font-size:12px;color:${THEME.mutedForeground};line-height:1.4;">
                © ${year} QueuePass. All rights reserved.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</div>
`

    await transporter.sendMail({
        from: `QueuePass <${fromUser}>`,
        to: opts.to,
        subject,
        text,
        html,
        attachments: logoAttachment ? [logoAttachment] : undefined,
    })
}

export async function sendLoginCredentialsEmail(opts: {
    to: string
    name?: string
    email: string
    password: string
    role?: string
    loginLink?: string
}) {
    const transporter = getTransporter()
    if (!transporter) {
        throw new Error("Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.")
    }

    const fromUser = process.env.GMAIL_USER!

    const loginLink = buildLoginLinkFromClientOrigin() ?? opts.loginLink ?? null

    const logoAttachment = getInlineLogoAttachment()
    const payload = buildSendLoginCredentialsEmail({
        name: opts.name,
        email: opts.email,
        password: opts.password,
        role: opts.role,
        loginLink,
        hasInlineLogo: Boolean(logoAttachment),
        logoCid: LOGO_PNG_CID,
        theme: THEME,
    })

    await transporter.sendMail({
        from: `QueuePass <${fromUser}>`,
        to: opts.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        attachments: logoAttachment ? [logoAttachment] : undefined,
    })
}