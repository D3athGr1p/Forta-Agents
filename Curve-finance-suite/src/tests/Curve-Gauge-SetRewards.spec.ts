import {
  Finding,
  HandleTransaction,
  createTransactionEvent,
} from "forta-agent";
import provideclaimManyAgent, {
  web3,
  claimMany,
} from "../agents/Curve-Dao-ClaimMany";

const ADDRESS = "0x1111";
const ALERTID = "NETHFORTA-21-8";

describe("high gas agent", () => {
  let handleTransaction: HandleTransaction;

  beforeAll(() => {
    handleTransaction = provideclaimManyAgent(ALERTID, ADDRESS);
  });

  const createTxEvent = (signature: string) =>
    createTransactionEvent({
      transaction: { data: signature } as any,
      addresses: { ADDRESS: true },
      receipt: {} as any,
      block: {} as any,
    });

  it("create and send a tx with the tx event", async () => {
    const signature = web3.eth.abi.encodeFunctionCall(claimMany as any, [
      [...Array(20)].map(
        (_, i) => "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
      ) as any,
    ]);

    const tx = createTxEvent(signature);
    const findings = await handleTransaction(tx);

    expect(findings).toStrictEqual([
      Finding.fromObject({
        name: "Claim Rewards funciton called",
        description: "Claim Rewards funciton called on pool",
        alertId: ALERTID,
        protocol: "ethereum",
        severity: 2,
        type: 2,
        everestId: undefined,
        metadata: {},
      }),
    ]);
  });
});
