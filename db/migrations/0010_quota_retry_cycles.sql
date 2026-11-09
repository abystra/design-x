ALTER TABLE quota_reservations ADD COLUMN cycle integer NOT NULL DEFAULT 0;
ALTER TABLE quota_ledger ADD COLUMN cycle integer NOT NULL DEFAULT 0;
ALTER TABLE quota_ledger DROP CONSTRAINT quota_ledger_reservation_id_action_key;
ALTER TABLE quota_ledger ADD CONSTRAINT quota_ledger_cycle_action_key UNIQUE(reservation_id,cycle,action);
