import {
  Finding,
  FindingSeverity,
  FindingType,
  HandleTransaction,
  Network,
  Label,
  EntityType,
  Initialize,
  ethers,
} from "forta-agent";
import { Interface } from "@ethersproject/abi";

import { TestTransactionEvent, MockEthersProvider } from "forta-agent-tools/lib/test";
import { createAddress, NetworkManager } from "forta-agent-tools";
import { provideInitialize, provideHandleTransaction } from "./agent";
import { when } from "jest-when";
import fetch, { Response } from "node-fetch";
import { AgentConfig, NetworkData, ERC20_TRANSFER_FUNCTION, BALANCEOF_ABI } from "./utils";
import BalanceFetcher from "./balance.fetcher";

jest.mock("node-fetch");
const BALANCE_IFACE = new Interface(BALANCEOF_ABI);

const mockChainId = 1;
const mockJwt = "MOCK_JWT";

const mockDBKeys = {
  transfersKey: "mock-pk-comp-value-bot-key",
  alertedAddressesKey: "mock-pk-comp-bot-alerted-addresses-key",
};

const mockpKCompValueTxns = {
  "0x0000000000000000000000000000000000000020": [createAddress("0x21")],
};

const mockpKCompAlertedAddresses = [{ address: createAddress("0x21"), timestamp: 1 }];

// Mock calculateAlertRate function of the bot-alert-rate module
const mockCalculateAlertRate = jest.fn();
jest.mock("bot-alert-rate", () => ({
  ...jest.requireActual("bot-alert-rate"),
  __esModule: true,
  default: () => mockCalculateAlertRate(),
}));

// Mock the fetchJwt function of the forta-agent module
const mockFetchJwt = jest.fn();
jest.mock("forta-agent", () => {
  const original = jest.requireActual("forta-agent");
  return {
    ...original,
    fetchJwt: () => mockFetchJwt(),
  };
});

const DEFAULT_CONFIG: AgentConfig = {
  [Network.MAINNET]: {
    threshold: "0.05",
    tokenName: "ETH",
  },
};

class MockEthersProviderExtension extends MockEthersProvider {
  public getBalance: any;

  constructor() {
    super();
    this.getBalance = jest.fn().mockReturnValue(ethers.BigNumber.from("0"));
  }

  public setBalance(addr: string, block: number, balance: number): MockEthersProviderExtension {
    when(this.getBalance).calledWith(addr, block).mockReturnValue(balance);
    return this;
  }
}
const senders = [
  createAddress("0x1"),
  createAddress("0x2"),
  createAddress("0x3"),
  createAddress("0x4"),
  createAddress("0x5"),
];

const receivers = [createAddress("0x11"), createAddress("0x12"), createAddress("0x13"), createAddress("0x14")];

const createFinding = (txHash: string, from: string[], to: string, assets: string[], anomalyScore: number): Finding => {
  const victims = from.map((victim) => {
    return Label.fromObject({
      entity: victim,
      entityType: EntityType.Address,
      label: "Victim",
      confidence: 0.6,
      remove: false,
    });
  });

  return Finding.fromObject({
    name: "Possible private key compromise",
    description: `${from.toString()} transferred funds to ${to}`,
    alertId: "PKC-1",
    severity: FindingSeverity.High,
    type: FindingType.Suspicious,
    metadata: {
      attacker: to,
      victims: from.toString(),
      transferredAssets: assets
        .filter(function (item, pos) {
          return assets.indexOf(item) == pos;
        })
        .toString(),
      anomalyScore: anomalyScore.toString(),
    },
    labels: [
      Label.fromObject({
        entity: txHash,
        entityType: EntityType.Transaction,
        label: "Attack",
        confidence: 0.6,
        remove: false,
      }),
      Label.fromObject({
        entity: to,
        entityType: EntityType.Address,
        label: "Attacker",
        confidence: 0.6,
        remove: false,
      }),
      ...victims,
    ],
  });
};

describe("Detect Private Key Compromise", () => {
  const mockPersistenceHelper = {
    persist: jest.fn(),
    load: jest.fn(),
  };
  let mockProvider: MockEthersProviderExtension;
  let mockFetch = jest.mocked(fetch, true);
  let initialize: Initialize;
  let handleTransaction: HandleTransaction;
  let networkManager: NetworkManager<NetworkData>;
  let mockFetchResponse: Response;
  let mockBalanceFetcher: BalanceFetcher;

  const mockContractFetcher = {
    getContractInfo: jest.fn(),
  };

  const mockDataFetcher = {
    isEoa: jest.fn(),
  };

  beforeAll(() => {
    mockProvider = new MockEthersProviderExtension();
    // mockPersistenceHelper = new PersistenceHelper(mockDbUrl);
    networkManager = new NetworkManager(DEFAULT_CONFIG, Network.MAINNET);
  });

  beforeEach(async () => {
    mockProvider.setNetwork(mockChainId);

    initialize = provideInitialize(networkManager, mockProvider as any, mockPersistenceHelper as any, mockDBKeys);
    const mockEnv = {};
    Object.assign(process.env, mockEnv);

    // mockFetchResponse = {
    //   ok: true,
    //   json: jest.fn().mockResolvedValue(Promise.resolve(mockpKCompValueTxns)),
    // } as any as Response;

    mockCalculateAlertRate.mockResolvedValueOnce("0.1");
    mockFetchJwt.mockResolvedValue(mockJwt);
    mockFetch.mockResolvedValue(mockFetchResponse);
    mockBalanceFetcher = new BalanceFetcher(mockProvider as any);

    await initialize();
    mockPersistenceHelper.load.mockResolvedValue(mockpKCompValueTxns).mockResolvedValue(mockpKCompAlertedAddresses);

    handleTransaction = provideHandleTransaction(
      mockProvider as any,
      networkManager,
      mockBalanceFetcher,
      mockContractFetcher as any,
      mockDataFetcher as any,
      mockPersistenceHelper as any,
      mockDBKeys
    );

    delete process.env.LOCAL_NODE;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const setTokenBalance = (tokenAddr: string, blockNumber: number, accAddr: string, balance: string) => {
    mockProvider.addCallTo(tokenAddr, blockNumber, BALANCE_IFACE, "balanceOf", {
      inputs: [accAddr],
      outputs: [ethers.BigNumber.from(balance)],
    });
  };

  describe("Transaction handler test suite", () => {
    it("returns empty findings if there is no native token transfers", async () => {
      const txEvent = new TestTransactionEvent();

      const findings = await handleTransaction(txEvent);

      expect(findings).toStrictEqual([]);
    });

    it("returns empty findings if there is 3 native transfers and 0 token transfers to an attacker address", async () => {
      let findings;
      const txEvent = new TestTransactionEvent().setFrom(senders[0]).setTo(receivers[0]);
      const txEvent2 = new TestTransactionEvent().setFrom(senders[1]).setTo(receivers[0]);
      const txEvent3 = new TestTransactionEvent().setFrom(senders[2]).setTo(receivers[0]);

      txEvent.setValue("1");
      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);
      txEvent2.setValue("2");
      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);
      txEvent3.setValue("3");
      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);
    });

    it("returns empty findings if there are 2 native transfers and 1 token transfer to an attacker address", async () => {
      let findings;
      const txEvent = new TestTransactionEvent().setFrom(senders[0]).setTo(receivers[0]);
      const txEvent2 = new TestTransactionEvent().setFrom(senders[1]).setTo(receivers[0]);
      const txEvent3 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[0], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[2]);

      setTokenBalance(createAddress("0x99"), 1, senders[2], "0");

      txEvent.setValue("1");
      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);
      txEvent2.setValue("2");
      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);
    });

    it("returns empty findings if there are 1 native transfers and 2 token transfer to an attacker address", async () => {
      let findings;
      const txEvent = new TestTransactionEvent().setFrom(senders[0]).setTo(receivers[0]);

      const txEvent2 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[0], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[1]);

      const txEvent3 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[0], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[2]);
      setTokenBalance(createAddress("0x99"), 1, senders[1], "0");
      setTokenBalance(createAddress("0x99"), 1, senders[2], "0");

      txEvent.setValue("1");
      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);
    });

    it("returns findings if there are more than 3 native transfers to a single address", async () => {
      let findings;
      const txEvent = new TestTransactionEvent().setFrom(senders[0]).setTo(receivers[0]);
      const txEvent2 = new TestTransactionEvent().setFrom(senders[1]).setTo(receivers[0]);
      const txEvent3 = new TestTransactionEvent().setFrom(senders[2]).setTo(receivers[0]);
      const txEvent4 = new TestTransactionEvent().setFrom(senders[3]).setTo(receivers[0]);

      when(mockDataFetcher.isEoa).calledWith(receivers[0]).mockReturnValue(true);

      txEvent.setValue("1");
      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);
      txEvent2.setValue("2");
      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);
      txEvent3.setValue("3");
      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);
      txEvent4.setValue("4");
      findings = await handleTransaction(txEvent4);
      expect(findings).toStrictEqual([
        createFinding("0x", [senders[0], senders[1], senders[2], senders[3]], receivers[0], ["ETH"], 0.1),
      ]);
    });

    it("returns findings if there are more than 3 token transfers", async () => {
      let findings;
      const txEvent = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[1], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[0]);

      const txEvent2 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[1], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[1]);

      const txEvent3 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[1], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[2]);

      const txEvent4 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[1], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[3]);

      const txEvent5 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[1], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[4]);

      setTokenBalance(createAddress("0x99"), 1, senders[0], "0");
      setTokenBalance(createAddress("0x99"), 1, senders[1], "0");
      setTokenBalance(createAddress("0x99"), 1, senders[2], "0");
      setTokenBalance(createAddress("0x99"), 1, senders[3], "0");

      when(mockDataFetcher.isEoa).calledWith(receivers[1]).mockReturnValue(true);

      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent4);
      expect(findings).toStrictEqual([
        createFinding(
          "0x",
          [senders[0], senders[1], senders[2], senders[3]],
          receivers[1],
          [createAddress("0x99")],
          0.1
        ),
      ]);

      findings = await handleTransaction(txEvent5);

      expect(findings).toStrictEqual([]);
    });

    it("returns findings if there are 3 native transfers and 1 token transfer to an attacker address", async () => {
      let findings;
      const txEvent = new TestTransactionEvent().setFrom(senders[0]).setTo(receivers[2]);
      const txEvent2 = new TestTransactionEvent().setFrom(senders[1]).setTo(receivers[2]);
      const txEvent3 = new TestTransactionEvent()
        .setBlock(1)
        .addTraces({
          to: createAddress("0x99"),
          function: ERC20_TRANSFER_FUNCTION,
          arguments: [receivers[2], ethers.BigNumber.from("1000000")],
          output: [],
        })
        .setFrom(senders[2]);

      const txEvent4 = new TestTransactionEvent().setFrom(senders[3]).setTo(receivers[2]);

      setTokenBalance(createAddress("0x99"), 1, senders[2], "0");
      when(mockDataFetcher.isEoa).calledWith(receivers[2]).mockReturnValue(true);

      txEvent.setValue("1");
      findings = await handleTransaction(txEvent);
      expect(findings).toStrictEqual([]);

      txEvent2.setValue("2");
      findings = await handleTransaction(txEvent2);
      expect(findings).toStrictEqual([]);

      findings = await handleTransaction(txEvent3);
      expect(findings).toStrictEqual([]);

      txEvent4.setValue("4");
      findings = await handleTransaction(txEvent4);
      expect(findings).toStrictEqual([
        createFinding(
          "0x",
          [senders[0], senders[1], senders[2], senders[3]],
          receivers[2],
          ["ETH", createAddress("0x99")],
          0.1
        ),
      ]);
    });
  });
});
