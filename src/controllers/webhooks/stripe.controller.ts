import express from 'express';
import { bot } from '../../main.js';
import { Constants } from '../../constants.js';
import { EmbedBuilder, TextChannel } from 'discord.js';

const app = express.Router();

type StripeBase<T = unknown> = {
  id: string;
  object: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
    } & T;
  };
};

type PaymentIntent = {
  amount: number;
  currency: number;
  created: number;
  description: string;
};

const isPaymentEvent = (payload: StripeBase): payload is StripeBase<PaymentIntent> =>
  payload.type === 'payment_intent.succeeded';

const isImmichProduct = (payload: StripeBase<PaymentIntent>) =>
  ['immich-server', 'immich-client'].includes(payload.data.object.description);

app.post('/stripe-payments/:slug', async (req, res) => {
  if (req.params.slug !== process.env.STRIPE_PAYMENT_SLUG) {
    res.status(401).send();
    return;
  }

  res.status(204).send();

  if (!isPaymentEvent(req.body) || !isImmichProduct(req.body)) {
    return;
  }

  const { id, description, amount, currency } = req.body.data.object;
  const licenseType = description.split('-')[1];
  const channel = (await bot.channels.fetch(Constants.Channels.Stripe)) as TextChannel;
  const embed = new EmbedBuilder({
    title: `Immich ${licenseType} license purchased`,
    author: { name: 'Stripe Payments', url: 'https://stripe.com' },
    url: `https://dashboard.stripe.com/payments/${id}`,
    description: `Total: ${amount} ${currency}`,
  });
  await channel.send({ embeds: [embed] });
});

export const stripeWebhooks = app;
