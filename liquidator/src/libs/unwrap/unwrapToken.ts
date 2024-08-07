import { Account, Keypair, Connection } from '@solana/web3.js';
import { checkAndUnwrapBasisTokens } from './basis/rBasisSwap';
import { checkAndUnwrapNLPTokens } from './nazare/unwrapNazareLp';
import { checkAndUnwrapKaminoTokens } from './kamino/unwrapKamino';
import { checkAndUnwrapXSolTokens } from './xsol/unwrapXSol';

export const unwrapTokens = async (connection: Connection, payer: Keypair) => {
  await checkAndUnwrapBasisTokens(connection, payer);
  await checkAndUnwrapNLPTokens(connection, payer);
  await checkAndUnwrapKaminoTokens(connection, payer);
  await checkAndUnwrapXSolTokens(connection, payer);
};
