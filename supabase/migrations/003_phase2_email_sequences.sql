-- Phase 2 slice A: adaptive 3–5 step EMAIL sequence templates (no LinkedIn).

UPDATE sequence_templates
SET
  name = 'Phase 2 Email 3-step',
  steps = '[
    {"step_index":1,"channel":"email","delay_business_days":0,"template_key":"cold_email_1","requires_hitl":true},
    {"step_index":2,"channel":"email","delay_business_days":3,"template_key":"cold_email_2","requires_hitl":true},
    {"step_index":3,"channel":"email","delay_business_days":5,"template_key":"cold_email_3","requires_hitl":true}
  ]'::jsonb
WHERE id = '11111111-1111-1111-1111-111111111111';

INSERT INTO sequence_templates (id, name, pillar, steps, active)
VALUES (
  '11111111-1111-1111-1111-111111111112',
  'Phase 2 Email 5-step (Tier-1)',
  NULL,
  '[
    {"step_index":1,"channel":"email","delay_business_days":0,"template_key":"cold_email_1","requires_hitl":true},
    {"step_index":2,"channel":"email","delay_business_days":2,"template_key":"cold_email_2","requires_hitl":true},
    {"step_index":3,"channel":"email","delay_business_days":4,"template_key":"cold_email_3","requires_hitl":true},
    {"step_index":4,"channel":"email","delay_business_days":7,"template_key":"cold_email_4","requires_hitl":true},
    {"step_index":5,"channel":"email","delay_business_days":10,"template_key":"cold_email_5","requires_hitl":true}
  ]'::jsonb,
  true
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  steps = EXCLUDED.steps,
  active = EXCLUDED.active;
