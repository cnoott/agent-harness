/** Shared by all phases of one guided assessment run, including retries/compaction. */
export class ResearchBudget {
  used = 0;
  constructor(readonly limit = 30) {}
  consume() {
    if (this.used >= this.limit) throw new Error('Assessment research model-call budget exhausted; saved partial evidence is retained.');
    this.used++;
  }
}
