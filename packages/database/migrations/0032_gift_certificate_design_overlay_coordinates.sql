-- Expand the certificate design with per-background overlay coordinates.
-- Percent values are relative to the top-left corner of the uploaded artwork.

alter table gift_certificates.designs
  add column code_x_percent numeric(5, 2) not null default 5.10
    check (code_x_percent between 0 and 100),
  add column code_y_percent numeric(5, 2) not null default 88.00
    check (code_y_percent between 0 and 100),
  add column amount_x_percent numeric(5, 2) not null default 78.30
    check (amount_x_percent between 0 and 100),
  add column amount_y_percent numeric(5, 2) not null default 88.00
    check (amount_y_percent between 0 and 100);
