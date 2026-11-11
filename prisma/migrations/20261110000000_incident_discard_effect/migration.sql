-- Kept in its own migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "IncidentStockEffect" ADD VALUE IF NOT EXISTS 'DISCARD';
