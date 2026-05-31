import { Terminal } from 'terminal-kit';
import { logger } from '../../utils/logger';
import { GSDTUI } from './GSDTUI';

let term: Terminal | null = null;

export async function initializeTUI(): Promise<GSDTUI | null> {
  try {
    term = new Terminal({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      generic: true,
    });

    // Test terminal capabilities
    if (!term.width || !term.height) {
      throw new Error('Terminal dimensions unavailable');
    }

    const tui = new GSDTUI(term);
    await tui.initialize();
    
    term.on('resize', () => {
      tui.handleResize();
    });

    return tui;
  } catch (error) {
    logger.error('TUI initialization failed:', error);
    
    if (term) {
      term.grabInput(false);
      term.hideCursor(false);
      term.clear();
    }
    
    console.error('\n❌ Terminal UI initialization failed');
    console.error('This may be due to terminal compatibility issues.');
    console.error('Try running with --no-tui flag to use basic console output.');
    
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    }
    
    return null;
  }
}

export function cleanupTUI(): void {
  if (term) {
    try {
      term.grabInput(false);
      term.hideCursor(false);
      term.clear();
    } catch (error) {
      logger.warn('Error during TUI cleanup:', error);
    }
  }
}