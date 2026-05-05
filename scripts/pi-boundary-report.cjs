#!/usr/bin/env node
// GSD-2 + scripts/pi-boundary-report.cjs — Diagnostic report for GSD-to-Pi package coupling
'use strict'

const { execFileSync } = require('node:child_process')

const patterns = [
	'@gsd/pi-',
	'packages/pi-',
	'PI_PACKAGE_DIR',
	'GSD_CODING_AGENT_DIR',
	'GSD_BUNDLED_EXTENSION_PATHS',
	'@mariozechner/',
]

for (const pattern of patterns) {
	process.stdout.write(`\n## ${pattern}\n`)
	try {
		const output = execFileSync('rg', [
			'-n',
			pattern,
			'src',
			'packages',
			'scripts',
			'docs',
			'package.json',
		], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		process.stdout.write(output)
	} catch (error) {
		if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
			process.stdout.write('(no matches)\n')
			continue
		}
		throw error
	}
}
