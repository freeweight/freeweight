---
title: List a model
summary: How a model owner puts a model on Freeweight and earns a share of its rent.
order: 80
group: Models
---

If you control a model repository on Hugging Face, you can ask to have the model listed. When people rent it, 30%
of the rent they pay is credited to your wallet address in the ledger.

> [!NOTE]
> In v0.1 every listing is approved by a person, and the owner share is paid out by hand. The payout schedule and
> the minimum payout are not set yet.

## What you need

- Write access to the model's repository on Hugging Face.
- A wallet. Its address becomes the owner of the listing.
- A model that passes the checks below.

## Steps

**1. Name your wallet in the README.** Add this line to `README.md` in the repository, on a line of its own, with
your own address:

```
freeweight-owner: 0x1234567890abcdef1234567890abcdef12345678
```

The line can stand alone, or sit in a list item or a quote. It proves that the person who controls the repository
chose that wallet. Commit it to the default branch. Upper and lower case in the address do not matter. The API
gives you the exact line for your wallet: `listing_proof_line` in `GET /api/me`, and `proof_line` on every
listing.

**2. Submit the repository.** Sign in on the site with the same wallet and enter the repository name, such as
`your-org/your-model`. From the API:

```
curl -X POST https://freeweight.xyz/api/listings \
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hf_repo": "your-org/your-model"}'
```

**3. Read the result.** The checks run at once. The answer lists every check with `ok` and a short `detail`. If
all pass, the listing is `pending`. If one fails, it is `rejected`, and the detail says why. Fix the repository and
submit again.

**4. Wait for approval.** A person at Freeweight looks at the listing. On approval the model is built for the GPU
and the listing moves to `building`, then to `listed`. A build that does not work ends as `failed`, with a reason.

You can read a listing at any time with `GET /api/listings/<id>`.

## The checks

| Check | What passes |
| ----- | ----------- |
| `public` | The repository is public. Not private, not gated, not disabled. |
| `license` | The model card names a licence on the allowlist. |
| `safetensors` | The weights are safetensors files. GGUF, bin and pickle files are not accepted. |
| `chat_template` | The tokenizer has a chat template. |
| `text_generation` | The model is a text-generation model. |
| `size` | The parameter count fits a tier. The largest accepted size is 72 billion parameters. |
| `owner_proof` | The README has a `freeweight-owner:` line with the wallet you are signed in with. |
| `pinned` | The repository has a commit to pin. |

The licence allowlist in v0.1: `apache-2.0`, `mit`, `bsd-3-clause`, the `llama3` family, `gemma`, `qwen` and
`tongyi-qianwen`. A licence outside the list is not a judgment about the model. Write to us if yours should be on
it.

The tier and the serving precision follow from the parameter count. The table is on the [models](/docs/models)
page.

## What gets pinned

The checks read the repository at its latest commit and pin that commit. The model is built and served from that
commit. A later change to the repository changes nothing on Freeweight.

To move a listed model to a newer commit, submit the repository again. The new commit goes through the checks and
the approval again.

## The owner share

- The share is 30% of the rent paid on your model. `GET /api/config` publishes it as `owner_share_bps`, where
  `3000` means 30%.
- It counts rent paid from a renter's balance. Free-try minutes earn no share, because nobody paid for them. The
  same will hold for minutes paid with perk credits, which are planned and not live.
- It is written to the ledger when a session on your model ends: one entry per session, under your wallet address,
  rounded down to a millionth of a dollar.
- Ledger entries cannot be edited or deleted.

## Payouts

v0.1 pays out by hand, and only to the owner wallet. There is no page yet that shows what you have accrued. Ask at
hello@freeweight.xyz.

The accrued share is a record of what Freeweight owes you. It is not a balance you can spend on the service, and
it is not a token.

## What is public

- Your wallet address appears in the catalog as the model's `owner`.
- Anyone who has the listing id can read the listing, with its checks and your wallet address.
- Listed models carry the tag `community`.

## Limits

- 20 listing checks per wallet per day.
- Text-generation models only.
- A listed model starts with tool calls marked as off. We switch that on after testing it.
- We can refuse or remove a listing. See [acceptable use](/docs/acceptable-use).
