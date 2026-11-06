"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { builderApplicationSchema, TRADES, TRADE_LABELS } from "@/lib/schemas";
import { api } from "../api";
import { useSubmit } from "../useSubmit";
import { Button, Checkbox, ErrorSummary, TextInput } from "../ui";

export function BuilderApplicationForm() {
  const [f, setF] = useState({ companyName: "", companiesHouseNumber: "", phone: "", districts: "", insuranceExpiresOn: "" });
  const [trades, setTrades] = useState<string[]>([]);
  const router = useRouter();
  const { run, busy, error, setError } = useSubmit(useCallback((_k: string, body: unknown) => api("/api/builder/application", { method: "POST", body, retrySafe: true }), []));
  const body = () => ({
    companyName: f.companyName, companiesHouseNumber: f.companiesHouseNumber, phone: f.phone, insuranceExpiresOn: f.insuranceExpiresOn,
    trades, serviceDistricts: f.districts.split(/[\s,]+/).filter(Boolean),
  });
  return (
    <form noValidate className="card" onSubmit={async (e) => {
      e.preventDefault();
      const p = builderApplicationSchema.safeParse(body());
      if (!p.success) {
        const fields: Record<string, string> = {};
        for (const i of p.error.issues) fields[String(i.path[0])] ??= i.message;
        return setError({ code: "VALIDATION_FAILED", message: "Some details need correcting.", fields, status: 422 });
      }
      const r = await run(body());
      if (r?.ok) {
        router.push("/builder");
        router.refresh();
      }
    }}>
      <ErrorSummary error={error} />
      <TextInput label="Company name" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} error={error?.fields?.companyName} />
      <TextInput label="Companies House number (optional)" value={f.companiesHouseNumber} onChange={(e) => setF({ ...f, companiesHouseNumber: e.target.value })} error={error?.fields?.companiesHouseNumber} />
      <TextInput label="Mobile" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={error?.fields?.phone} />
      <fieldset className="field">
        <legend><strong>Trades</strong></legend>
        {error?.fields?.trades ? <p className="error-text">{error.fields.trades}</p> : null}
        {TRADES.map((t) => (
          <Checkbox key={t} label={TRADE_LABELS[t]} checked={trades.includes(t)} onChange={(e) => setTrades((list) => (e.target.checked ? [...list, t] : list.filter((x) => x !== t)))} />
        ))}
      </fieldset>
      <TextInput label="Postcode districts you cover" hint="Separate with commas, for example SE15, SE22, SE5" value={f.districts} onChange={(e) => setF({ ...f, districts: e.target.value })} error={error?.fields?.serviceDistricts} />
      <TextInput label="Public liability insurance expiry (optional)" type="date" value={f.insuranceExpiresOn} onChange={(e) => setF({ ...f, insuranceExpiresOn: e.target.value })} error={error?.fields?.insuranceExpiresOn} />
      <p className="small">We check ID, insurance, trade registrations (such as Gas Safe where needed) and references before approving.</p>
      <Button type="submit" busy={busy}>Send application</Button>
    </form>
  );
}
