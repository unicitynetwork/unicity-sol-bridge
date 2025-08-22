import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { UnicityBridge } from "../target/types/unicity_bridge";

describe("unicity-bridge", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.unicityBridge as Program<UnicityBridge>;

  it("Is initialized!", async () => {
    // Add your test here.
    const provider = anchor.AnchorProvider.env();
    const adminPubkey = provider.wallet.publicKey;
    const tx = await program.methods.initialize(adminPubkey).rpc();
    console.log("Your transaction signature", tx);
  });
});
