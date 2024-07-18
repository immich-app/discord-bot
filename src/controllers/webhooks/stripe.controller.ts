import express from 'express';
import { bot } from '../../main.js';
import { Constants } from '../../constants.js';
import { EmbedBuilder, TextChannel } from 'discord.js';

const app = express.Router();

type StripeBase = {
  id: string;
  object: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
    };
  };
};

type StripePaymentIntent = StripeBase & {
  data: {
    object: {
      amount: number;
      currency: number;
      created: number;
      description: string;
    };
  };
};

const isStripePaymentIntentSucceeded = (payload: StripeBase): payload is StripePaymentIntent => {
  if ((payload as StripeBase).type === 'payment_intent.succeeded') {
    return true;
  }
  return false;
};

const isImmichPaymentIntent = (payload: StripePaymentIntent): payload is StripePaymentIntent => {
  return ['immich-server', 'immich-client'].includes((payload as StripePaymentIntent).data.object.description);
};

app.post('/stripe-payments/:slug', async (req, res) => {
  if (req.params.slug !== process.env.STRIPE_PAYMENT_SLUG) {
    res.status(401).send();
    return;
  }

  res.status(204).send();

  const body = req.body;

  if (!isStripePaymentIntentSucceeded(body) || !isImmichPaymentIntent(body)) return;

  const paymentIntent = body.data.object;

  const licenseType = paymentIntent.description.split('-')[1];
  const channel = (await bot.channels.fetch(Constants.Channels.Stripe)) as TextChannel;
  const embed = new EmbedBuilder({
    title: `Immich ${licenseType} license purchased`,
    author: { name: 'Stripe Payments', url: 'https://stripe.com' },
    url: `https://dashboard.stripe.com/payments/${body.id}`,
    description: `Total: ${paymentIntent.amount} ${paymentIntent.currency}`,
  });
  await channel.send({ embeds: [embed] });
});

export const stripeWebhooks = app;
