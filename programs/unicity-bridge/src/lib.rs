use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

declare_id!("9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB");

#[program]
pub mod unicity_bridge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        bridge_state.admin = admin;
        bridge_state.total_locked = 0;
        bridge_state.nonce = 0;
        
        emit!(BridgeInitialized {
            admin,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        Ok(())
    }

    pub fn lock_sol(ctx: Context<LockSol>, amount: u64, unicity_recipient: String) -> Result<()> {
        require!(amount > 0, BridgeError::InvalidAmount);
        require!(unicity_recipient.len() <= 64, BridgeError::InvalidRecipient);

        let bridge_state = &mut ctx.accounts.bridge_state;
        let user = &ctx.accounts.user;
        let escrow = &ctx.accounts.escrow;

        // Transfer SOL from user to escrow
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &user.key(),
            &escrow.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                user.to_account_info(),
                escrow.to_account_info(),
            ],
        )?;

        // Update bridge state
        bridge_state.total_locked = bridge_state.total_locked.checked_add(amount)
            .ok_or(BridgeError::Overflow)?;
        bridge_state.nonce = bridge_state.nonce.checked_add(1)
            .ok_or(BridgeError::Overflow)?;

        // Create lock event
        let mut data = Vec::new();
        data.extend_from_slice(&user.key().to_bytes());
        data.extend_from_slice(&bridge_state.nonce.to_le_bytes());
        data.extend_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
        let lock_id = hash(&data).to_bytes();

        emit!(TokenLocked {
            lock_id,
            user: user.key(),
            amount,
            unicity_recipient,
            nonce: bridge_state.nonce,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        let bridge_state = &ctx.accounts.bridge_state;
        require!(ctx.accounts.admin.key() == bridge_state.admin, BridgeError::Unauthorized);

        let escrow = &ctx.accounts.escrow;
        let admin = &ctx.accounts.admin;
        
        // Transfer all SOL from escrow to admin
        let escrow_balance = escrow.lamports();
        **escrow.try_borrow_mut_lamports()? -= escrow_balance;
        **admin.try_borrow_mut_lamports()? += escrow_balance;

        emit!(EmergencyWithdrawal {
            admin: admin.key(),
            amount: escrow_balance,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + BridgeState::INIT_SPACE,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockSol<'info> {
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(
        mut,
        seeds = [b"escrow"],
        bump
    )]
    /// CHECK: This is safe as it's just an escrow account holding SOL
    pub escrow: AccountInfo<'info>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(
        mut,
        seeds = [b"escrow"],
        bump
    )]
    /// CHECK: This is safe as it's just an escrow account holding SOL
    pub escrow: AccountInfo<'info>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct BridgeState {
    pub admin: Pubkey,
    pub total_locked: u64,
    pub nonce: u64,
}

#[event]
pub struct BridgeInitialized {
    pub admin: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct TokenLocked {
    pub lock_id: [u8; 32],
    pub user: Pubkey,
    pub amount: u64,
    pub unicity_recipient: String,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct EmergencyWithdrawal {
    pub admin: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum BridgeError {
    #[msg("Invalid amount: must be greater than 0")]
    InvalidAmount,
    #[msg("Invalid recipient address")]
    InvalidRecipient,
    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
