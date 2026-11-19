import { createPublicBackends, createSoundRuntime } from '@phimacs/sound';
import { startCli } from '../../bin/tau.js';

const backends = createPublicBackends().register('fixture', {
  validate(options: unknown) {
    if (options === null || typeof options !== 'object' || !('text' in options) || typeof options.text !== 'string') {
      throw new Error('Fixture backend needs text.');
    }
    return options.text;
  },
  open(text) {
    if (text === 'fail to open') throw new Error('Fixture backend failed to open.');
    return { write() {}, async finish() { return text; }, close() {} };
  },
});
startCli(createSoundRuntime({ backends }));
