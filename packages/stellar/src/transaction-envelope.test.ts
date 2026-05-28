/**
 * Stellar Transaction Envelope Serialization Tests
 *
 * Tests for multi-operation transaction envelope serialization to verify:
 * - Operation order preservation through serialize/deserialize
 * - Signature validity after serialization round-trip
 * - No data loss in multi-operation batches
 */

import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Account,
  Transaction,
} from 'stellar-sdk';
import { describe, it, expect, beforeEach } from 'vitest';

describe('Transaction Envelope Serialization', () => {
  let sourceKeypair: Keypair;
  let destinationKeypair: Keypair;
  let account: Account;

  beforeEach(() => {
    sourceKeypair = Keypair.random();
    destinationKeypair = Keypair.random();
    account = new Account(sourceKeypair.publicKey(), '1000');
  });

  describe('Multi-Operation Serialization Round-Trip', () => {
    it('should preserve operation order through serialize/deserialize', () => {
      // Create a transaction with multiple operations in specific order
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .addOperation(
          Operation.changeTrust({
            asset: new Asset('USD', sourceKeypair.publicKey()),
            limit: '1000',
          })
        )
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: new Asset('USD', sourceKeypair.publicKey()),
            amount: '5',
          })
        )
        .setTimeout(30)
        .build();

      // Serialize to XDR
      const xdr = transaction.toXDR();

      // Deserialize from XDR
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      // Verify operation count
      expect(deserialized.operations).toHaveLength(3);

      // Verify operation order is preserved
      expect(deserialized.operations[0].type).toBe('payment');
      expect(deserialized.operations[1].type).toBe('changeTrust');
      expect(deserialized.operations[2].type).toBe('payment');

      // Verify operation details
      const payment1 = deserialized.operations[0] as any;
      expect(payment1.destination).toBe(destinationKeypair.publicKey());
      expect(payment1.amount).toBe('10');

      const changeTrust = deserialized.operations[1] as any;
      expect(changeTrust.line.code).toBe('USD');
      expect(changeTrust.limit).toBe('1000');

      const payment2 = deserialized.operations[2] as any;
      expect(payment2.destination).toBe(destinationKeypair.publicKey());
      expect(payment2.amount).toBe('5');
    });

    it('should preserve all operation types used by templates', () => {
      const issuerKeypair = Keypair.random();
      const asset = new Asset('TOKEN', issuerKeypair.publicKey());

      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.createAccount({
            destination: destinationKeypair.publicKey(),
            startingBalance: '2',
          })
        )
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '100',
          })
        )
        .addOperation(
          Operation.changeTrust({
            asset,
            limit: '10000',
          })
        )
        .addOperation(
          Operation.setOptions({
            homeDomain: 'example.com',
          })
        )
        .addOperation(
          Operation.manageData({
            name: 'config',
            value: Buffer.from('test-data'),
          })
        )
        .setTimeout(30)
        .build();

      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      expect(deserialized.operations).toHaveLength(5);
      expect(deserialized.operations[0].type).toBe('createAccount');
      expect(deserialized.operations[1].type).toBe('payment');
      expect(deserialized.operations[2].type).toBe('changeTrust');
      expect(deserialized.operations[3].type).toBe('setOptions');
      expect(deserialized.operations[4].type).toBe('manageData');

      // Verify operation data integrity
      const createAccount = deserialized.operations[0] as any;
      expect(createAccount.destination).toBe(destinationKeypair.publicKey());
      expect(createAccount.startingBalance).toBe('2');

      const manageData = deserialized.operations[4] as any;
      expect(manageData.name).toBe('config');
      expect(manageData.value?.toString()).toBe('test-data');
    });

    it('should handle mixed operation types without data loss', () => {
      const asset1 = new Asset('USD', Keypair.random().publicKey());
      const asset2 = new Asset('EUR', Keypair.random().publicKey());

      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.changeTrust({
            asset: asset1,
            limit: '5000',
          })
        )
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: asset1,
            amount: '100',
          })
        )
        .addOperation(
          Operation.changeTrust({
            asset: asset2,
            limit: '3000',
          })
        )
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: asset2,
            amount: '50',
          })
        )
        .setTimeout(30)
        .build();

      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      expect(deserialized.operations).toHaveLength(4);

      // Verify alternating pattern is preserved
      expect(deserialized.operations[0].type).toBe('changeTrust');
      expect(deserialized.operations[1].type).toBe('payment');
      expect(deserialized.operations[2].type).toBe('changeTrust');
      expect(deserialized.operations[3].type).toBe('payment');

      // Verify asset details
      const trust1 = deserialized.operations[0] as any;
      expect(trust1.line.code).toBe('USD');
      expect(trust1.line.issuer).toBe(asset1.issuer);

      const payment1 = deserialized.operations[1] as any;
      expect(payment1.asset.code).toBe('USD');
      expect(payment1.amount).toBe('100');

      const trust2 = deserialized.operations[2] as any;
      expect(trust2.line.code).toBe('EUR');
      expect(trust2.line.issuer).toBe(asset2.issuer);

      const payment2 = deserialized.operations[3] as any;
      expect(payment2.asset.code).toBe('EUR');
      expect(payment2.amount).toBe('50');
    });
  });

  describe('Signature Preservation', () => {
    it('should preserve signatures after serialization round-trip', () => {
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .setTimeout(30)
        .build();

      // Sign the transaction
      transaction.sign(sourceKeypair);

      // Verify signature exists
      expect(transaction.signatures).toHaveLength(1);
      const originalSignature = transaction.signatures[0];

      // Serialize and deserialize
      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      // Verify signature is preserved
      expect(deserialized.signatures).toHaveLength(1);
      expect(deserialized.signatures[0].signature()).toEqual(originalSignature.signature());
      expect(deserialized.signatures[0].hint()).toEqual(originalSignature.hint());
    });

    it('should preserve multiple signatures after round-trip', () => {
      const signer1 = Keypair.random();
      const signer2 = Keypair.random();

      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .setTimeout(30)
        .build();

      // Sign with multiple signers
      transaction.sign(sourceKeypair);
      transaction.sign(signer1);
      transaction.sign(signer2);

      expect(transaction.signatures).toHaveLength(3);

      // Serialize and deserialize
      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      // Verify all signatures are preserved
      expect(deserialized.signatures).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(deserialized.signatures[i].signature()).toEqual(
          transaction.signatures[i].signature()
        );
        expect(deserialized.signatures[i].hint()).toEqual(transaction.signatures[i].hint());
      }
    });

    it('should maintain signature validity after serialization', () => {
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(sourceKeypair);

      // Get transaction hash before serialization
      const originalHash = transaction.hash();

      // Serialize and deserialize
      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      // Verify transaction hash is identical (signatures are valid for same tx)
      expect(deserialized.hash()).toEqual(originalHash);

      // Verify signature can be verified against the deserialized transaction
      const signature = deserialized.signatures[0];
      const signatureBase = deserialized.hash();

      // The signature should be valid for the deserialized transaction
      expect(sourceKeypair.verify(signatureBase, signature.signature())).toBe(true);
    });
  });

  describe('Multi-Operation Batch Serialization', () => {
    it('should handle large multi-operation batches', () => {
      const builder = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      });

      // Add 10 operations
      for (let i = 0; i < 10; i++) {
        builder.addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: `${i + 1}`,
          })
        );
      }

      const transaction = builder.setTimeout(30).build();
      transaction.sign(sourceKeypair);

      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      expect(deserialized.operations).toHaveLength(10);

      // Verify each operation amount is correct and in order
      for (let i = 0; i < 10; i++) {
        const op = deserialized.operations[i] as any;
        expect(op.amount).toBe(`${i + 1}`);
      }

      // Verify signature is preserved
      expect(deserialized.signatures).toHaveLength(1);
    });

    it('should preserve operation source accounts in multi-op batches', () => {
      const opSource1 = Keypair.random();
      const opSource2 = Keypair.random();

      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            source: opSource1.publicKey(),
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .addOperation(
          Operation.payment({
            source: opSource2.publicKey(),
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '20',
          })
        )
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '30',
          })
        )
        .setTimeout(30)
        .build();

      const xdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;

      expect(deserialized.operations).toHaveLength(3);

      // Verify operation sources
      expect(deserialized.operations[0].source).toBe(opSource1.publicKey());
      expect(deserialized.operations[1].source).toBe(opSource2.publicKey());
      expect(deserialized.operations[2].source).toBeUndefined(); // Uses transaction source
    });
  });

  describe('Byte-Level Serialization Correctness', () => {
    it('should produce identical XDR on repeated serialization', () => {
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .addOperation(
          Operation.changeTrust({
            asset: new Asset('USD', sourceKeypair.publicKey()),
            limit: '1000',
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(sourceKeypair);

      // Serialize multiple times
      const xdr1 = transaction.toXDR();
      const xdr2 = transaction.toXDR();

      // Should produce identical output
      expect(xdr1).toBe(xdr2);
    });

    it('should produce identical XDR after deserialize-serialize cycle', () => {
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .addOperation(
          Operation.changeTrust({
            asset: new Asset('USD', sourceKeypair.publicKey()),
            limit: '1000',
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(sourceKeypair);

      const originalXdr = transaction.toXDR();
      const deserialized = TransactionBuilder.fromXDR(originalXdr, Networks.TESTNET) as Transaction;
      const reserializedXdr = deserialized.toXDR();

      // Should produce identical XDR
      expect(reserializedXdr).toBe(originalXdr);
    });

    it('should handle base64 and hex encoding consistently', () => {
      const transaction = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: '10',
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(sourceKeypair);

      // Serialize in different formats
      const base64Xdr = transaction.toXDR('base64');
      const hexXdr = transaction.toXDR('hex');

      // Deserialize from both formats
      const fromBase64 = TransactionBuilder.fromXDR(base64Xdr, Networks.TESTNET) as Transaction;
      const fromHex = TransactionBuilder.fromXDR(hexXdr, Networks.TESTNET) as Transaction;

      // Both should produce identical transactions
      expect(fromBase64.hash()).toEqual(fromHex.hash());
      expect(fromBase64.toXDR()).toBe(fromHex.toXDR());
    });
  });
});
