/**
 * Terminal presentation helpers for CLI-side notices on stderr — warnings,
 * hints, and names. Pairs with the extension-side glyph set in
 * resources/extensions/shared/ui.ts. Adopt incrementally: banner-shaped CLI
 * surfaces (worktree banners today; update checks et al. as they're touched)
 * should render through these instead of ad-hoc chalk.
 */

import chalk from 'chalk'

/** Dim "[gsd] " line tag that prefixes CLI banner lines. */
function gsdTag(): string {
  return chalk.dim('[gsd] ')
}

/** A yellow warning fragment. */
export function warn(text: string): string {
  return chalk.yellow(text)
}

/** A dim "what to do next" hint fragment. */
function hint(text: string): string {
  return chalk.dim(text)
}

/** A cyan user-supplied name (worktree, branch, file). */
export function name(text: string): string {
  return chalk.cyan(text)
}

/** One banner line: tagged warning followed by a tagged hint line. */
export function bannerLines(warning: string, hintText: string): string {
  return gsdTag() + warning + '\n' + gsdTag() + hint(hintText) + '\n\n'
}
