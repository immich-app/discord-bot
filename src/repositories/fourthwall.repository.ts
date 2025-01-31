import { FourthwallOrder, IFourthwallRepository } from 'src/interfaces/fourthwall.interface';

export class FourthwallRepository implements IFourthwallRepository {
  async getOrder({ id, user, password }: { id: string; user: string; password: string }): Promise<FourthwallOrder> {
    const foo = await fetch(`https://api.fourthwall.com/api/orders/${id}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    });
    return foo.json();
  }
}
