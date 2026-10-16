-- ETAP 8: new IntegrationType values. Kept in its own migration because a value
-- added by ALTER TYPE cannot be used in the same transaction.

ALTER TYPE "IntegrationType" ADD VALUE 'WEBHOOK';
ALTER TYPE "IntegrationType" ADD VALUE 'GOOGLE_SHEETS';
ALTER TYPE "IntegrationType" ADD VALUE 'MAKE';
ALTER TYPE "IntegrationType" ADD VALUE 'ZAPIER';
