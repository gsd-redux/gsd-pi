import { Command } from 'commander';
import { startTUI } from '../../tui';
import { logger } from '../../utils/logger';

export const createRootCommand = (): Command => {
  const program = new Command();
  
  program
    .name('gsd')
    .description('GSD - Get Shit Done')
    .action(async () => {
      try {
        await startTUI();
      } catch (error) {
        logger.error('Failed to start TUI:', error);
        process.exit(1);
      }
    });

  return program;
};