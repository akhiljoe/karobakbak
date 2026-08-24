import {
  ENFORCEMENT_DIMENSIONS,
  enforcementRowIds,
  newEnforcementId,
} from '../../src/util/ids';

/**
 * These are security tests, not shape tests.
 *
 * `enforcementRowIds` replaced `enforcement_id like $1 || '%'` in the revoke
 * path. That query treated the console's request body as a SQL pattern, so a
 * body of `%` revoked every non-revoked sanction in the table and lifted every
 * corresponding Redis ban key — with an audit row that recorded the wildcard
 * rather than the decisions it undid. The assertions below are the ones that
 * would have failed on that code.
 */
describe('enforcement id validation', () => {
  const base = newEnforcementId();

  it('expands a base id into exactly the rows that decision wrote', () => {
    const target = enforcementRowIds(base);
    expect(target).not.toBeNull();
    expect(target?.base).toBe(base);
    expect(target?.rowIds).toEqual([`${base}_ip`, `${base}_client`]);
    // Exhaustive: nothing else can carry this decision's id.
    expect(target?.rowIds).toHaveLength(ENFORCEMENT_DIMENSIONS.length);
  });

  it('accepts either form the console holds, and normalises them to the same rows', () => {
    // `issueBan` returns the base id; the listings return per-dimension ids.
    // Both circulate in the console, and revoking lifts both dimensions either
    // way — a sanction that covered the address and not the cookie would be a
    // decision nobody made.
    const fromBase = enforcementRowIds(base);
    const fromIp = enforcementRowIds(`${base}_ip`);
    const fromClient = enforcementRowIds(`${base}_client`);
    expect(fromIp).toEqual(fromBase);
    expect(fromClient).toEqual(fromBase);
  });

  it('refuses a SQL wildcard rather than matching everything with it', () => {
    // The finding, exactly: one request that revoked the whole table.
    expect(enforcementRowIds('%')).toBeNull();
    expect(enforcementRowIds('enf_%')).toBeNull();
    expect(enforcementRowIds('%_ip')).toBeNull();
    expect(enforcementRowIds('_')).toBeNull();
    expect(enforcementRowIds('enf_%%%%%%%%%%%%%%%%%%%%%%')).toBeNull();
  });

  it('refuses a prefix of a real id, so a short string cannot fan out', () => {
    // Under `like`, every one of these matched the real sanction — and every
    // other sanction sharing the prefix.
    expect(enforcementRowIds('enf_')).toBeNull();
    expect(enforcementRowIds(base.slice(0, 10))).toBeNull();
    expect(enforcementRowIds(base.slice(0, base.length - 1))).toBeNull();
  });

  it('refuses anything that is not this id shape', () => {
    expect(enforcementRowIds('')).toBeNull();
    expect(enforcementRowIds('s_0123456789abcdefghijkl')).toBeNull();
    expect(enforcementRowIds(`${base}_admin`)).toBeNull();
    expect(enforcementRowIds(`${base}_ip_ip`)).toBeNull();
    expect(enforcementRowIds(` ${base}`)).toBeNull();
    expect(enforcementRowIds(`${base}\n`)).toBeNull();
    // A dimension suffix on its own is not a decision.
    expect(enforcementRowIds('_ip')).toBeNull();
  });

  it('reads a base id whose random part ends in a dimension suffix as a base id', () => {
    // base64url can end in anything, so `enf_<...>_ip` is ambiguous on its
    // face. The length of the stripped candidate settles it: a real base is
    // always `enf_` plus 22 characters.
    const awkward = 'enf_AAAAAAAAAAAAAAAAAAA_ip';
    expect(awkward).toHaveLength('enf_'.length + 22);
    const target = enforcementRowIds(awkward);
    expect(target?.base).toBe(awkward);
    expect(target?.rowIds).toEqual([`${awkward}_ip`, `${awkward}_client`]);
  });

  it('accepts every id this process actually generates', () => {
    // base64url includes `-` and `_`; a stricter character class would refuse
    // roughly a third of real ids, which is a worse failure than it looks —
    // moderators would be unable to revoke exactly the sanctions they issued.
    for (let i = 0; i < 500; i += 1) {
      const generated = newEnforcementId();
      expect(enforcementRowIds(generated)).not.toBeNull();
      expect(enforcementRowIds(`${generated}_client`)?.base).toBe(generated);
    }
  });
});
