import type { JobStatus } from "../domain/jobStateMachine";
import type { MediaKind } from "@/lib/fileTypes";

export interface JobRow {
  id: string;
  homeownerId: string;
  status: JobStatus;
  trade: string;
  title: string;
  description: string;
  postcodeDistrict: string;
  standardScope: string | null;
  beatPercent: string | null;
  beatPricePence: number | null;
  currentWindow: "crew" | "partner" | null;
  windowEndsAt: Date | null;
  submissionKey: string | null;
  submittedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddressRow { jobId: string; line1: string; line2: string | null; town: string; postcode: string }
export interface QuoteRow { jobId: string; quotePricePence: number; rivalCompanyName: string | null; quoteDate: string | null }

export interface BuilderRow {
  id: string;
  kind: "crew" | "partner" | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  companyName: string;
  companiesHouseNumber: string | null;
  trades: string[];
  serviceDistricts: string[];
  insuranceExpiresOn: string | null;
  stripeAccountId: string | null;
  createdAt: Date;
}

export interface OfferRow {
  id: string;
  jobId: string;
  builderId: string;
  viaWindow: "crew" | "partner";
  pricePence: number;
  status: "pending" | "accepted" | "declined" | "expired" | "withdrawn";
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface ContractRow {
  id: string;
  jobId: string;
  offerId: string;
  homeownerId: string;
  builderId: string;
  pricePence: number;
  depositPence: number;
  termsVersion: string;
  status: "active" | "terminated" | "completed";
  homeownerAcceptedAt: Date;
  terminatedReason: string | null;
}

export interface VariationRow {
  id: string;
  jobId: string;
  contractId: string;
  proposedBy: string;
  reason: "not_reasonably_visible" | "homeowner_requested";
  description: string;
  amountPence: number;
  status: "proposed" | "approved" | "declined" | "withdrawn";
  decidedAt: Date | null;
  createdAt: Date;
}

export interface MediaRow {
  id: string;
  jobId: string;
  uploadedBy: string;
  kind: MediaKind;
  status: "pending_upload" | "uploaded" | "processing" | "ready" | "quarantined" | "rejected" | "deleted";
  scanStatus: "not_scanned" | "clean" | "infected" | "scanner_unavailable";
  clientFingerprint: string;
  originalFilename: string;
  declaredMime: string;
  detectedMime: string | null;
  sizeBytes: string | number;
  sha256: string | null;
  storagePath: string;
  processedPath: string | null;
  thumbnailPath: string | null;
  metadataStripped: boolean;
  visibleToBuilders: boolean;
  errorCode: string | null;
  attempts: number;
  uploadExpiresAt: Date;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  jobId: string;
  contractId: string;
  kind: "deposit" | "stage" | "final" | "refund";
  amountPence: number;
  status: "created" | "pending" | "succeeded" | "failed" | "cancelled" | "unknown" | "refunded";
  providerSessionId: string | null;
  providerPaymentIntentId: string | null;
  idempotencyKey: string;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> { items: T[]; nextCursor: string | null }
