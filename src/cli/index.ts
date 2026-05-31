import { Command } from 'commander';
import { generateGsd } from '../core/gsd-generator';
import { logger } from '../utils/logger';

const program = new Command();

program
  .name('gsd')
  .description('GSD (Get Shit Done) - AI-powered task management')
  .version('1.0.0')
  .option('-v, --verbose', 'enable verbose output')
  .option('-d, --debug', 'enable debug mode')
  .action(async (options) => {
    try {
      if (options.debug) {
        process.env.DEBUG = 'true';
        }
        
      if (options.verbose) {
        logger.setLevel('verbose');
      }
      
      logger.debug('Starting GSD CLI execution');
      
      const result = await generateGsd();
      
      if (result) {
        console.log(result);
      }
      
      logger.debug('GSD CLI execution completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('An error occurred during execution:', error);
      
      if (options.debug) {
        console.error('Error details:', error);
      }
      
      process.exit(1);
    }
  });

async function main() {
  try {
    program.parse(process.argv);
  } catch (error) {
    logger.error('Unhandled error in CLI entry point:', error);
    console.error('An unexpected error occurred. Enable debug mode (-d) for more details.');
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  console.error('Uncaught Exception:', error.message || error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

main();
