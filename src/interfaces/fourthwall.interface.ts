export const IFourthwallRepository = 'IFourthwallRepository';

type Price = { value: number; currency: string };

export interface FourthwallOrder {
  type: string;
  profit: Price;
  id: string;
  friendlyId: string;
  cartId: string;
  checkoutId: string;
  giftId: any;
  status: string;
  refund: {
    elements: [
      {
        type: string;
        data: {
          type: string;
          amount: Price;
          issuer: string;
          reason: string;
        };
        createdAt: string;
        principalName: any;
      },
    ];
  };
  cancellation: FourthwallCancellation;
  shopId: string;
  email: string;
  offers: [
    {
      offer: FourthwallOffer;
      variant: FourthwallVariant;
      variantId: string;
      quantity: number;
      price: Price;
    },
  ];
  offersCancelled: [
    {
      offer: FourthwallOffer;
      variant: FourthwallVariant;
      variantId: string;
      quantity: number;
      price: Price;
    },
  ];
  currentAmounts: {
    offers: Price;
    shipping: Price;
    tax: Price;
    discount: Price;
    total: Price;
  };
  cancelledAmounts: {
    offers: Price;
    shipping: Price;
    tax: Price;
    discount: Price;
    total: Price;
  };
  paidPaymentFee: any;
  paidBySupporter: Price;
  totalTax: {
    total: Price;
    totalRate: number;
    elements: [{ amount: Price; rate: number; title: string; taxType: string }];
  };
  merchandiseTotal: Price;
  donation: any;
  discount: any;
  creatorBudget: any;
  billing: { address: Address };
  shipping: {
    address: Address;
    method: string;
    price: Price;
    shipments: [
      {
        id: string;
        items: [{ offerId: string; variantId: string }];
        shippingRate: {
          id: string;
          shipmentId: string;
          service: string;
          description: string;
          price: Price;
          type: string;
        };
      },
    ];
  };
  replacement: any;
  additionalFields: [{ name: string; value: string }];
  createdAt: string;
  updatedAt: string;
  fulfillmentStatus: string;
  message?: string;
  salesChannel: { type: string };
  totalPrice: Price;
}

export interface FourthwallCancellation {
  cancellationType: string;
  position: number;
  issuer: string;
  issuedAt: string;
  principalName: any;
  reason: string;
  cancelledItems: any;
  cancelledAmounts: any;
}

export interface FourthwallOffer {
  type: string;
  id: string;
  shopId: string;
  customizationId: string;
  productId: string;
  bespokeProductId: any;
  membershipTierVariantId: any;
  requirements: { allowedTiers: any };
  name: string;
  slug: string;
  description: string;
  variantTypes: [
    {
      type: string;
      title: string;
      options: [
        {
          name: string;
          colorSwatch?: string;
          price: any;
          compareAtPrice: any;
          weight: any;
          id: string;
        },
      ];
      variesBy: {
        price: boolean;
        height: boolean;
        imagery: boolean;
      };
    },
  ];
  fulfillingService: string;
  manufacturingService: string;
  drop: any;
  digitalItems: any[];
  additionalSections: [{ type: string; title: string; bodyHtml: string }];
  soundScanInfo: any;
  visualHints: { customSkus: boolean };
  metafields: any;
  createdAt: string;
  updatedAt: string;
  state: { status: string; available: boolean };
  variants: FourthwallVariant[];
}

export interface FourthwallVariant {
  type: string;
  id: string;
  offerId: string;
  shopId: string;
  status: string;
  name: string;
  slug: string;
  sku: string;
  productVariantId: string;
  price: Price;
  compareAtPrice: any;
  weight: { value: number; unit: string };
  dimensions: { length: number; width: number; height: number; unit: string };
  attributesList: [{ name: string; colorSwatch?: string; type: string }];
  settings: { requiresShipping: boolean; taxable: boolean; isSoundScanProduct: boolean; donation: boolean };
  images: string[];
  position: number;
  quantity: any;
  metafields: any;
  createdAt: string;
  updatedAt: string;
  unitPrice: Price;
  attributesDescription: string;
  colorAttribute: { name: string; colorSwatch: string; type: string };
  sizeAttribute?: { name: string; type: string };
  customAttribute: any;
  colorOption: { name: string; colorSwatch: string; type: string };
  customOption: any;
  sizeOption?: { name: string; type: string };
  attributes: { COLOR: string; SIZE?: string };
  colorName: string;
  size: string;
  colorSwatch: string;
  customVariationValue: string;
  options: { requiresShiping: boolean; taxable: boolean; isSoundScanProduct: boolean; donation: boolean };
  productId: any;
  barcode: any;
}

interface Address {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  phone: string;
  vatId: any;
}

export interface FourthwallOrderCreateWebhook {
  testMode: boolean;
  id: string;
  webhookId: string;
  shopId: string;
  type: 'ORDER_PLACED';
  apiVersion: string;
  createdAt: string;
  data: FourthwallOrderData;
}

interface FourthwallOrderData {
  amounts: { discount: Price; donation: Price; shipping: Price; subtotal: Price; tax: Price; total: Price };
  billing: { address: Address };
  checkoutId: string;
  createdAt: string;
  email: string;
  emailMarketingOptIn: boolean;
  friendlyId: string;
  id: string;
  message?: string;
  offers: FourthwallOffer[];
  shipping: { address: Address };
  shopId: string;
  source: { type: string };
  status: string;
  updatedAt: string;
  username?: string;
}

export interface FourthwallOrderUpdateWebhook {
  testMode: boolean;
  id: string;
  webhookId: string;
  shopId: string;
  type: 'ORDER_UPDATED';
  apiVersion: string;
  createdAt: string;
  data: FourthwallOrderData & { update: { type: string } };
}

export interface IFourthwallRepository {
  getOrder({ id, user, password }: { id: string; user: string; password: string }): Promise<FourthwallOrder>;
}
