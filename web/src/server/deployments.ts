export type ChainDeployment = {
  chainId: number;
  name: string;
  explorer: string;
  factoryBlock: number;
  targetTransaction: string;
  factoryTransaction: string;
};

export const DEPLOYMENTS: readonly ChainDeployment[] = Object.freeze([
  {
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    factoryBlock: 50801478,
    targetTransaction: "0xcbcbae4a479dd585ea3ed49e052ca5f706c22a30a55e934916872f45faa010b0",
    factoryTransaction: "0x3def1ca5cdbc57368c9ab83ef7a8a99d1c48001c52f7ecef133f6b8f678b1f19",
  },
  {
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    factoryBlock: 26113629,
    targetTransaction: "0x1808c8f82dce3907399414a2deea40471a0bc5ce2fc32642fdcef0a821d9ce8f",
    factoryTransaction: "0xcfe0a0053dd0bf73d1f15300a0aca48ed0067c170a2426580117c1f72decd0bf",
  },
  {
    chainId: 4663,
    name: "Robinhood Chain",
    explorer: "https://robin.etherscan.io",
    factoryBlock: 79297347,
    targetTransaction: "0x11ebbb3761db2fc26153cfff287aca8f4c4b65de70effe182679571fc71ffba6",
    factoryTransaction: "0xea380624bd6552b11d906ef0bfb22fc27c76a8248274ee5e042f2fd227817691",
  },
]);
