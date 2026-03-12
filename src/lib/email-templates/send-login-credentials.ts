type Theme = {
    background: string
    foreground: string
    primary: string
    primaryForeground: string
    secondary: string
    muted: string
    mutedForeground: string
    border: string
    ring: string
}

function escapeHtml(input: string) {
    return String(input ?? "")
        .split("&").join("&amp;")
        .split("<").join("&lt;")
        .split(">").join("&gt;")
        .split('"').join("&quot;")
        .split("'").join("&#039;")
}

export function buildSendLoginCredentialsEmail(opts: {
    name?: string
    email: string
    password: string
    role?: string
    loginLink: string | null
    hasInlineLogo: boolean
    logoCid: string
    supportEmail?: string
    theme: Theme
}) {
    const theme = opts.theme
    const year = new Date().getFullYear()

    const safeName = opts.name ? escapeHtml(String(opts.name).trim()) : ""
    const greeting = safeName ? `Hi ${safeName},` : "Hi,"

    const subject = "Your QueuePass login credentials"
    const safeSupportEmail = opts.supportEmail
        ? escapeHtml(String(opts.supportEmail).trim())
        : ""

    const text = [
        opts.name ? `Hi ${String(opts.name).trim()},` : "Hi,",
        "",
        "Your QueuePass account has been created.",
        "",
        `Email: ${opts.email}`,
        `Password: ${opts.password}`,
        opts.role ? `Role: ${opts.role}` : "",
        "",
        opts.loginLink ? `Login: ${opts.loginLink}` : "Login: (CLIENT_ORIGIN not configured)",
        "",
        "For security, please change your password after logging in.",
        opts.supportEmail
            ? `Need help? Contact ${String(opts.supportEmail).trim()}.`
            : "If you did not expect this email, contact your administrator.",
        "",
        "— QueuePass",
    ]
        .filter(Boolean)
        .join("\n")

    const logoInnerHtml = opts.hasInlineLogo
        ? `<img src="cid:${opts.logoCid}" alt="QueuePass logo"
              style="display:block;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:10px;" />`
        : `<div
              style="width:100%;height:100%;border-radius:10px;border:1px solid ${theme.border};background:${theme.background};
                     font-family:Arial, sans-serif;font-weight:800;font-size:12px;color:${theme.foreground};
                     display:block;line-height:36px;text-align:center;">
              QP
           </div>`

    const rolePill = opts.role
        ? `<span style="display:inline-block;padding:6px 10px;border-radius:999px;background:${theme.secondary};
                         border:1px solid ${theme.border};font-size:12px;color:${theme.foreground};font-weight:800;">
              ${escapeHtml(opts.role)}
           </span>`
        : ""

    const safeLoginLink = opts.loginLink ? escapeHtml(opts.loginLink) : null

    const loginCta = safeLoginLink
        ? `
        <div style="margin:0 0 14px 0;">
          <a href="${safeLoginLink}"
             style="display:inline-block;background:${theme.primary};color:${theme.primaryForeground};
                    text-decoration:none;padding:12px 14px;border-radius:14px;font-size:14px;font-weight:900;">
            Login to QueuePass
          </a>
        </div>

        <div style="font-size:12px;color:${theme.mutedForeground};line-height:1.5;margin:0 0 14px 0;">
          If the button doesn’t work, copy and paste this link:
          <div style="margin-top:8px;padding:10px 12px;border-radius:14px;background:${theme.secondary};
                      border:1px solid ${theme.border};word-break:break-all;
                      font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace;
                      font-size:12px;color:${theme.foreground};">
            ${safeLoginLink}
          </div>
        </div>
        `
        : `
        <div style="margin:0 0 14px 0;padding:12px 12px;border-radius:14px;background:${theme.secondary};
                    border:1px solid ${theme.border};color:${theme.mutedForeground};font-size:13px;line-height:1.5;">
          CLIENT_ORIGIN is not configured, so a login link cannot be generated.
        </div>
        `

    const supportHtml = safeSupportEmail
        ? `
        <div style="font-size:12px;color:${theme.mutedForeground};line-height:1.5;margin:14px 0 0 0;">
          Need help? Contact
          <a href="mailto:${safeSupportEmail}" style="color:${theme.primary};text-decoration:none;font-weight:700;">
            ${safeSupportEmail}
          </a>.
        </div>
        `
        : ""

    const footerSupportHtml = safeSupportEmail
        ? `
        <div style="font-family:Arial, sans-serif;font-size:12px;color:${theme.mutedForeground};line-height:1.5;margin-top:8px;">
          Support:
          <a href="mailto:${safeSupportEmail}" style="color:${theme.primary};text-decoration:none;font-weight:700;">
            ${safeSupportEmail}
          </a>
        </div>
        `
        : ""

    const html = `
<div style="margin:0;padding:0;background:${theme.muted};width:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Your QueuePass login credentials
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
    style="background:${theme.muted};padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">

          <tr>
            <td style="padding:0 0 14px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                style="border:1px solid ${theme.border};background:${theme.background};border-radius:18px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td width="46" valign="middle" style="padding-right:12px;">
                          <div style="width:46px;height:46px;border-radius:14px;border:1px solid ${theme.border};
                                      background:${theme.background};overflow:hidden;padding:4px;box-sizing:border-box;">
                            <div style="width:38px;height:38px;">
                              ${logoInnerHtml}
                            </div>
                          </div>
                        </td>

                        <td valign="middle" style="font-family:Arial, sans-serif;">
                          <div style="font-size:14px;font-weight:900;color:${theme.foreground};line-height:1.2;">
                            QueuePass
                          </div>
                          <div style="font-size:12px;color:${theme.mutedForeground};line-height:1.2;">
                            Ticketless QR Queue
                          </div>
                        </td>

                        <td align="right" valign="middle" style="font-family:Arial, sans-serif;">
                          <div style="font-size:12px;color:${theme.mutedForeground};">
                            Login Credentials
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                style="border:1px solid ${theme.border};background:${theme.background};border-radius:18px;">
                <tr>
                  <td style="padding:20px 18px 18px 18px;font-family:Arial, sans-serif;color:${theme.foreground};">

                    <div style="font-size:20px;font-weight:900;letter-spacing:-0.2px;margin:0 0 6px 0;">
                      Your account is ready
                    </div>
                    <div style="font-size:13px;color:${theme.mutedForeground};margin:0 0 16px 0;line-height:1.5;">
                      Use the credentials below to sign in to QueuePass.
                    </div>

                    <div style="font-size:14px;line-height:1.6;margin:0 0 10px 0;">
                      ${greeting}
                    </div>

                    ${rolePill ? `<div style="margin:0 0 14px 0;">${rolePill}</div>` : ""}

                    <div style="margin:0 0 14px 0;padding:12px 12px;border-radius:14px;background:${theme.secondary};
                                border:1px solid ${theme.border};">
                      <div style="font-size:12px;color:${theme.mutedForeground};margin:0 0 6px 0;">Email</div>
                      <div style="font-size:14px;font-weight:900;color:${theme.foreground};word-break:break-word;">
                        ${escapeHtml(opts.email)}
                      </div>

                      <div style="height:10px;"></div>

                      <div style="font-size:12px;color:${theme.mutedForeground};margin:0 0 6px 0;">Temporary Password</div>
                      <div style="font-size:16px;font-weight:900;color:${theme.foreground};
                                  font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace;">
                        ${escapeHtml(opts.password)}
                      </div>
                    </div>

                    ${loginCta}

                    <div style="font-size:12px;color:${theme.mutedForeground};line-height:1.5;margin:0;">
                      For security, please change your password after logging in. If you did not expect this email, contact your administrator.
                    </div>

                    ${supportHtml}

                  </td>
                </tr>

                <tr>
                  <td style="padding:14px 18px;border-top:1px solid ${theme.border};background:${theme.background};border-radius:0 0 18px 18px;">
                    <div style="font-family:Arial, sans-serif;font-size:12px;color:${theme.mutedForeground};line-height:1.5;">
                      For security reasons, please do not share your password with anyone.
                    </div>
                    ${footerSupportHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:14px 6px 0 6px;">
              <div style="font-family:Arial, sans-serif;font-size:12px;color:${theme.mutedForeground};line-height:1.4;">
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

    return { subject, text, html }
}