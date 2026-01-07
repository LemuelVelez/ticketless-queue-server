import nodemailer from "nodemailer"

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
    // Avoid String.prototype.replaceAll (TS target < ES2021)
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

    // Remove trailing slash safely without replaceAll
    const origin = originRaw.replace(/\/$/, "")
    return `${origin}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * Theme conversion from src/index.css (OKLCH -> HEX) approximations:
 * - background: #FFFFFF
 * - foreground: #0C0A09
 * - primary: #008D87
 * - primary-foreground: #FAFAF9
 * - secondary: #E5F8F6
 * - muted: #EFF7F6
 * - muted-foreground: #576766
 * - border/input: #E7E5E4
 * - ring: #18A7A1
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

export async function sendPasswordResetEmail(opts: {
    to: string
    name?: string
    resetLink?: string // backward-compat; used only if CLIENT_ORIGIN is missing
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

    // ✅ Prefer CLIENT_ORIGIN, fallback to opts.resetLink if needed
    const resetLink = buildResetLinkFromClientOrigin(opts.token) ?? opts.resetLink ?? null

    // Plain text fallback
    const text = [
        opts.name ? `Hi ${opts.name.trim()},` : "Hi,",
        "",
        "We received a request to reset your QueuePass password.",
        "",
        resetLink ? `Reset link: ${resetLink}` : "Reset link: (CLIENT_ORIGIN not configured)",
        `Reset token: ${opts.token}`,
        "",
        `This token expires in ${opts.expiresMinutes} minutes.`,
        "If you did not request this, you can ignore this email.",
        "",
        "— QueuePass",
    ].join("\n")

    const year = new Date().getFullYear()

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

          <!-- Header / Brand -->
          <tr>
            <td style="padding:0 0 14px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                style="border:1px solid ${THEME.border};background:${THEME.background};border-radius:18px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td width="46" valign="middle" style="padding-right:12px;">
                          <div
                            style="width:46px;height:46px;border-radius:14px;border:1px solid ${THEME.border};background:${THEME.background};
                                   font-family:Arial, sans-serif;font-weight:800;font-size:14px;color:${THEME.foreground};
                                   display:block;line-height:46px;text-align:center;">
                            QP
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

                    <!-- CTA -->
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

                    <!-- Token -->
                    <div style="font-size:12px;color:${THEME.mutedForeground};margin:0 0 8px 0;">
                      Or use this reset token:
                    </div>

                    <div style="margin:0 0 14px 0;padding:12px 12px;border-radius:14px;background:${THEME.secondary};
                                border:1px solid ${THEME.border};word-break:break-all;
                                font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace;
                                font-size:13px;color:${THEME.foreground};">
                      ${escapeHtml(opts.token)}
                    </div>

                    <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.5;margin:0 0 6px 0;">
                      This token expires in <b style="color:${THEME.foreground};">${opts.expiresMinutes} minutes</b>.
                    </div>

                    <div style="font-size:12px;color:${THEME.mutedForeground};line-height:1.5;margin:0;">
                      If you did not request this, you can safely ignore this email.
                    </div>

                  </td>
                </tr>

                <!-- Footer inside card -->
                <tr>
                  <td style="padding:14px 18px;border-top:1px solid ${THEME.border};background:${THEME.background};border-radius:0 0 18px 18px;">
                    <div style="font-family:Arial, sans-serif;font-size:12px;color:${THEME.mutedForeground};line-height:1.5;">
                      For security reasons, please do not share this token with anyone.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Outer footer -->
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
    })
}
