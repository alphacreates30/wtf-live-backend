-- transaction.tracking_carrier_account (the field the label-purchase code
-- was storing into tracking_carrier) isn't a field Shippo returns on a
-- Transaction, so tracking_carrier has been null on every order to date.
-- The real carrier name is rate.provider; Shippo's own tracking page for
-- the shipment is transaction.tracking_url_provider, stored here so buyers
-- link straight to it instead of a guessed carrier-slug URL.
alter table orders add column if not exists tracking_url text;
