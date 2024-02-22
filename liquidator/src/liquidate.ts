/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
import { Account, Connection, Keypair, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  generateKeypairFromBuffer,
  getObligations,
  getReserves,
  getWalletBalances,
  getWalletDistTarget,
  getWalletTokenData,
  sortBorrows,
  wait,
} from "libs/utils";
import { getTokensOracleData } from "libs/pyth";
import { Borrow, calculateRefreshedObligation } from "libs/refreshObligation";
import { readSecret } from "libs/secret";
import { liquidateAndRedeem } from "libs/actions/liquidateAndRedeem";
import { rebalanceWallet } from "libs/rebalanceWallet";
import { Jupiter } from "@jup-ag/core";
import { unwrapTokens } from "libs/unwrap/unwrapToken";
import { parseObligation } from "@solendprotocol/solend-sdk";
import { getMarkets } from "./config";
import { sendMessageToSlack } from "./libs/slack";

dotenv.config();

async function runLiquidator() {
  const rpcEndpoint = process.env.RPC_ENDPOINT;
  if (!rpcEndpoint) {
    throw new Error(
      "Pls provide an private RPC endpoint in docker-compose.yaml",
    );
  }
  const markets = await getMarkets();

  console.log("markets", markets);
  const connection = new Connection(rpcEndpoint, "confirmed");
  // liquidator's keypair.
  const keypairBuffer = JSON.parse(process.env.KEYPAIR_BUFFER!) as Uint8Array;
  const payer = generateKeypairFromBuffer(keypairBuffer);
  console.log("secret key size:", payer.secretKey.length);
  // const payer = new Account(keypair.secretKey);
  // const payer = new Account(JSON.parse(readSecret('keypair')));
  // const jupiter = await Jupiter.load({
  //   connection,
  //   cluster: 'mainnet-beta',
  //   user: Keypair.fromSecretKey(payer.secretKey),
  //   wrapUnwrapSOL: false,
  // });
  const target = getWalletDistTarget();
  const sendToSlack = async (message: string) => {
    return await sendMessageToSlack(message, process.env.SLACK_WEBHOOK_URL!);
  };

  console.log(`
    app: ${process.env.APP}
    rpc: ${rpcEndpoint}
    wallet: ${payer.publicKey.toString()}
    slack endpoint: ${process.env.SLACK_WEBHOOK_URL}
    auto-rebalancing: ${target.length > 0 ? "ON" : "OFF"}
    rebalancingDistribution: ${process.env.TARGETS}
    
    Running against ${markets.length} pools
  `);

  // Single run only
  // for (let epoch = 0; ; epoch += 1) {
  for (const market of markets) {
    const tokensOracle = await getTokensOracleData(connection, market);
    const allObligations = await getObligations(connection, market.address);
    const allReserves = await getReserves(connection, market.address);

    for (let obligation of allObligations) {
      try {
        while (obligation) {
          const { borrowedValue, unhealthyBorrowValue, deposits, borrows } =
            calculateRefreshedObligation(
              obligation.info,
              allReserves,
              tokensOracle,
            );

          // Do nothing if obligation is healthy
          if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
            break;
          }

          // select repay token that has the highest market value
          const selectedBorrow: Borrow | undefined = sortBorrows(borrows)[0];

          // select the withdrawal collateral token with the highest market value
          let selectedDeposit;
          deposits.forEach((deposit) => {
            if (
              !selectedDeposit ||
              deposit.marketValue.gt(selectedDeposit.marketValue)
            ) {
              selectedDeposit = deposit;
            }
          });

          if (!selectedBorrow || !selectedDeposit) {
            // skip toxic obligations caused by toxic oracle data
            break;
          }

          console.log(`Obligation ${obligation.pubkey.toString()} is underwater
              borrowedValue: ${borrowedValue.toString()}
              unhealthyBorrowValue: ${unhealthyBorrowValue.toString()}
              market address: ${market.address}`);

          // get wallet balance for selected borrow token
          const { balanceBase } = await getWalletTokenData(
            connection,
            market,
            payer,
            selectedBorrow.mintAddress,
            selectedBorrow.symbol,
          );
          if (balanceBase === 0) {
            const msg = `insufficient ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}`;
            console.log(msg);
            await sendToSlack(msg);
            break;
          } else if (balanceBase < 0) {
            const msg = `failed to get wallet balance for ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()} in market: ${market.address}. 
            Potentially network error or token account does not exist in wallet`;
            console.log(msg);
            await sendToSlack(msg);
            break;
          }

          // Set super high liquidation amount which acts as u64::MAX as program will only liquidate max
          // 50% val of all borrowed assets.
          await liquidateAndRedeem(
            connection,
            payer,
            balanceBase,
            selectedBorrow.symbol,
            selectedDeposit.symbol,
            market,
            obligation,
          );

          const postLiquidationObligation = await connection.getAccountInfo(
            new PublicKey(obligation.pubkey),
          );
          obligation = parseObligation(
            obligation.pubkey,
            postLiquidationObligation!,
          );

          await sendToSlack(
            `Liquidated obligation ${obligation?.pubkey.toString()} in market: ${market.address}`,
          );
        }
      } catch (err) {
        console.error(
          `error liquidating ${obligation!.pubkey.toString()}: `,
          err,
        );
        await sendToSlack(
          `Error liquidating obligation ${obligation?.pubkey.toString()} in market: ${market.address}`,
        );
        continue;
      }
    }

    await unwrapTokens(connection, payer);

    // NOTE: Will skip token checking and rebalancing for now.
    // if (target.length > 0) {
    //   const walletBalances = await getWalletBalances(
    //     connection,
    //     payer,
    //     tokensOracle,
    //     market,
    //   );
    //   await rebalanceWallet(connection, payer, jupiter, tokensOracle, walletBalances, target);
    // }

    // Throttle to avoid rate limiter
    if (process.env.THROTTLE) {
      await wait(Number(process.env.THROTTLE));
    }
  }
}
// }

runLiquidator();
