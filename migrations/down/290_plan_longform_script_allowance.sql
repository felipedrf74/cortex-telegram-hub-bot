-- Down for 290: restore the pre-290 (migration 284) long-form script seed.

UPDATE plan_configs
SET longform_scripts_daily = CASE plan_id
      WHEN 'pro' THEN 6
      WHEN 'max' THEN 20
      ELSE longform_scripts_daily
    END
WHERE plan_id IN ('pro', 'max');
