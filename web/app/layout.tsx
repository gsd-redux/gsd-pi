import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { verifyCloudSessionCookie } from '@/lib/cloud-auth'
import { CLOUD_SESSION_COOKIE, getCloudModeConfig, isCloudMode } from '@/lib/cloud-mode'
import './globals.css'

export const metadata: Metadata = {
  title: 'GSD',
  description: 'The evolution of Git Ship Done — now a real coding agent. One command. Walk away. Come back to a built project.',
  applicationName: 'GSD',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Cloud mode (ADR-047): inject the verified session claims so client
  // components can gate cloud-only behavior (viewer role, no exit hook).
  let cloudClientSession: string | null = null
  if (isCloudMode()) {
    try {
      const secret = getCloudModeConfig().appBridgeSecret
      const cookieStore = await cookies()
      const raw = cookieStore.get(CLOUD_SESSION_COOKIE)?.value
      const session = raw ? verifyCloudSessionCookie(raw, secret) : null
      if (session) {
        // Escape `<` so the JSON can safely live inside an inline script tag.
        cloudClientSession = JSON.stringify({
          sub: session.sub,
          deviceId: session.deviceId,
          role: session.role,
          projects: session.projects,
        }).replace(/</g, '\\u003c')
      }
    } catch {
      // Missing/invalid cloud env or cookie — render without a session;
      // the proxy already blocks unauthenticated API access.
    }
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        {cloudClientSession ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__GSD_CLOUD__=${cloudClientSession}`,
            }}
          />
        ) : null}
        <ThemeProvider attribute="class" defaultTheme="dark">
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  )
}
