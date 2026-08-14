/**
 * Shared GSD-Pi branding — re-exports wordmark from resources/shared and
 * adds render helpers for loader, onboarding, and installer surfaces.
 */

import { GSD_PI_BRAND, GSD_PI_LOGO } from './resources/shared/gsd-pi-logo.js'

export { GSD_PI_BRAND, GSD_PI_LOGO }

/** Project website — shown in installer, loader, and onboarding surfaces. */
export const GSD_WEBSITE = 'https://opengsd.net'

/**
 * Render the GSD-Pi wordmark with a color function applied to each line.
 */
export function renderGsdPiLogo(color: (s: string) => string): string {
  return '\n' + GSD_PI_LOGO.map(color).join('\n') + '\n'
}
