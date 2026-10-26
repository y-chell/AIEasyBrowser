const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const target = path.resolve(__dirname, '..', 'utils.ts');
const originalLoad = Module._load;
let nodePathDirectory;
const helpers = {
  colorText: (text) => text,
  writeNodePathFile(directory) {
    if (process.env.AIEASYBROWSER_FIXTURE_NODE_PATH_FAIL === '1') {
      throw new Error('Failed to write Node.js path: fixture failure');
    }
    nodePathDirectory = directory;
  },
  async tryRegisterUserLevelHost(browsers) {
    console.log(`registration-fixture:${JSON.stringify({ browsers, nodePathDirectory })}`);
    return process.env.AIEASYBROWSER_FIXTURE_REGISTRATION_FAIL !== '1';
  },
  ensureExecutionPermissions: async () => undefined,
  getLogDir: () => os.tmpdir(),
};

Module._load = function (request, parent, isMain) {
  if (Module._resolveFilename(request, parent, isMain) === target) return helpers;
  return originalLoad.call(this, request, parent, isMain);
};
