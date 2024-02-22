import { parsePriceData } from "@pythnetwork/client";
import { AggregatorState } from "@switchboard-xyz/switchboard-api";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { MarketConfig, MarketConfigReserve } from "global";

const NULL_ORACLE = "nu11111111111111111111111111111111111111111";
const SWITCHBOARD_V1_ADDRESS = "DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM";
const SWITCHBOARD_V2_ADDRESS = "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f";

let switchboardV2: SwitchboardProgram | undefined;

export type TokenOracleData = {
  symbol: string;
  reserveAddress: string;
  mintAddress: string;
  decimals: BigNumber;
  price: BigNumber;
};

async function getTokenOracleData(
  connection: Connection,
  reserve: MarketConfigReserve,
) {
  let priceData;
  const oracle = {
    priceAddress: reserve.pythOracle,
    switchboardFeedAddress: reserve.switchboardOracle,
  };

  if (oracle.priceAddress && oracle.priceAddress !== NULL_ORACLE) {
    const pricePublicKey = new PublicKey(oracle.priceAddress);
    const result = await connection.getAccountInfo(pricePublicKey);
    const { price, previousPrice } = parsePriceData(result!.data);
    priceData = price || previousPrice;
  }

  // only fetch from switchboard if not already available from pyth
  if (!priceData) {
    const pricePublicKey = new PublicKey(oracle.switchboardFeedAddress);
    const info = await connection.getAccountInfo(pricePublicKey);
    const owner = info?.owner.toString();
    if (owner === SWITCHBOARD_V1_ADDRESS) {
      const result = AggregatorState.decodeDelimited(
        (info?.data as Buffer)?.slice(1),
      );
      priceData = result?.lastRoundResult?.result;
    } else if (owner === SWITCHBOARD_V2_ADDRESS) {
      if (!switchboardV2) {
        switchboardV2 = await SwitchboardProgram.loadMainnet(connection);
      }
      const result = switchboardV2.decodeLatestAggregatorValue(info!);
      priceData = result?.toNumber();
    } else {
      console.error("unrecognized switchboard owner address: ", owner);
    }
  }

  if (!priceData) {
    console.error(
      `failed to get price for ${reserve.liquidityToken.symbol} | reserve ${reserve.address}`,
    );
    priceData = 0;
  }

  return {
    symbol: reserve.liquidityToken.symbol,
    reserveAddress: reserve.address,
    mintAddress: reserve.liquidityToken.mint,
    decimals: new BigNumber(10 ** reserve.liquidityToken.decimals),
    price: new BigNumber(priceData!),
  } as TokenOracleData;
}

// export async function getTokensOracleData(connection: Connection, market: MarketConfig) {
//   // We get an error trying to do this in parallel, either need to reduce number of markets
//   // or refactor to use getMultipleAccounts call
//   const promises: Promise<any>[] = market.reserves.map((reserve) => getTokenOracleData(connection, reserve));
//   return Promise.all(promises);
// }

function getTokenOracleAccount(
  reserve: MarketConfigReserve,
  switchboardV2: SwitchboardProgram,
) {
  const oracle = {
    priceAddress: reserve.pythOracle,
    switchboardFeedAddress: reserve.switchboardOracle,
  };
  let pricePublicKey;
  let parsingFunction;

  if (oracle.priceAddress && oracle.priceAddress !== NULL_ORACLE) {
    pricePublicKey = new PublicKey(oracle.priceAddress);
    // const result = await connection.getAccountInfo(pricePublicKey);
    parsingFunction = (r: any) => {
      const { price, previousPrice } = parsePriceData(r!.data);
      return price || previousPrice;
    };
  } else {
    pricePublicKey = new PublicKey(oracle.switchboardFeedAddress);
    // const info = await connection.getAccountInfo(pricePublicKey);
    parsingFunction = (info: any) => {
      let priceData = 0;
      const owner = info?.owner.toString();
      if (owner === SWITCHBOARD_V1_ADDRESS) {
        const result = AggregatorState.decodeDelimited(
          (info?.data as Buffer)?.slice(1),
        );
        priceData = result?.lastRoundResult?.result!;
      } else if (owner === SWITCHBOARD_V2_ADDRESS) {
        // if (!switchboardV2) {
        //   switchboardV2 = await SwitchboardProgram.loadMainnet(connection);
        // }
        const result = switchboardV2.decodeLatestAggregatorValue(info!);
        priceData = result?.toNumber()!;
      } else {
        console.error("unrecognized switchboard owner address: ", owner);
        console.error(
          `failed to get price for ${reserve.liquidityToken.symbol} | reserve ${reserve.address}`,
        );
      }
      return priceData;
    };
  }

  const fcn = (info: any) => {
    return {
      symbol: reserve.liquidityToken.symbol,
      reserveAddress: reserve.address,
      mintAddress: reserve.liquidityToken.mint,
      decimals: new BigNumber(10 ** reserve.liquidityToken.decimals),
      price: new BigNumber(parsingFunction(info)!),
    } as TokenOracleData;
  };

  return {
    fcn,
    pricePublicKey,
  };
}

// Rewrite of the function utilizing getMultipleAccounts
export async function getTokensOracleData(
  connection: Connection,
  market: MarketConfig,
) {
  const switchboardV2 = await SwitchboardProgram.loadMainnet(connection);
  const info = market.reserves.map((reserve) =>
    getTokenOracleAccount(reserve, switchboardV2!),
  );
  const N = 100;
  const accounts: any[] = [];
  for (let i = 0; i < Math.ceil(info.length / N); i += N) {
    const subArray = info.slice(i, i + N);
    const keys = subArray.map((x) => x.pricePublicKey);
    const result = await connection.getMultipleAccountsInfo(keys);
    accounts.push(...result);
  }
  const result = accounts.map((x, i) => info[i].fcn(x));
  return result;
}
