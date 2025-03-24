import { log, createLogger } from '../utils/logging';

// Test basic logging
console.log('Testing basic logging...');
log('This is a test message', 'info');

// Test logger creation
console.log('Testing logger creation...');
const logger = createLogger('test-logger');

// Test all logger methods
console.log('Testing all logger methods...');
logger.debug('This is a debug message');
logger.info('This is an info message');
logger.warning('This is a warning message');
logger.warn('This is a warn message (should be same as warning)');
logger.error('This is an error message');
logger.success('This is a success message');

console.log('Logging test completed successfully');