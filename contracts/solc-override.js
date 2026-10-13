// Offline compiler: LOCAL_SOLC=/path/to/solc-0.8.28 (native) or SOLCJS_PATH=/path/to/soljson.js uses a local
// compiler when binaries.soliditylang.org is unreachable. Unset, Hardhat downloads solc normally.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (process.env.LOCAL_SOLC && args.solcVersion === "0.8.28")
    return { compilerPath: process.env.LOCAL_SOLC, isSolcJs: false, version: args.solcVersion, longVersion: "0.8.28+commit.7893614a" };
  return runSuper();
});
