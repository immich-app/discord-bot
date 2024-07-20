import { Inject, Injectable } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';

@Injectable()
export class DatabaseService {
  constructor(@Inject(IDatabaseRepository) private repository: IDatabaseRepository) {}

  async runMigrations() {
    await this.repository.runMigrations();
  }
}
