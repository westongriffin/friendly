# Builds "Friendly Pay". Input is JSON from Friendly:
#   {"to": "+12145551234", "amt": "9.65", "note": "White Box Roastery Co. · Friendly"}
#   python3 build-pay.py OUT main   -> the real shortcut: Send Payment (Apple Cash) to the number, then reopen Friendly
#   python3 build-pay.py OUT inapp  -> one-tap test with Sarah's $1 built in and the action's "Open in App" switch on
#   python3 build-pay.py OUT card   -> variant that looks the number up in Contacts and pays the saved card (kept for
#                                      the record: it changes nothing on Apple's sheet, see below, and a card with
#                                      several numbers would pay the first one, not the one Friendly meant)
#   python3 build-pay.py OUT probe  -> the card variant with the payment swapped for text output, for a Mac
#
# Amount: {"Value": {"Unit": "USD", "Magnitude": <variable>}, "WFSerializationType": "WFQuantityFieldValue"}, fed from a
# Text step. A variable magnitude is fetched as an NSNumber and a JSON number comes back as __NSCFNumber, which crashes
# WFHandlePaymentIntentAction's decimalNumberByRoundingAccordingToBehavior: call ("There was a problem running the
# shortcut", v2-v4). Text coerces to NSDecimalNumber. Friendly sends amt as text.
#
# Why the sheet shows the number and not the name (read from the iOS 26.5 PassKitIntentsExtension, Oct 18 2026):
# the sheet's title is intent.payee.displayName, and the extension rebuilds the payee itself in
# -[PKPeerPaymentIntentHandler resolveSiriMatchesForPerson:]. It searches Contacts only for person.siriMatches, the
# matches Siri attaches when a name is spoken. A shortcut-built payee has none, so it falls to
# _personForDictatedPhoneNumberOrEmail:, whose displayName is the formatted handle (CNPhoneNumber pkFormattedStringValue,
# no Contacts lookup) with no name components. Whatever Shortcuts passes (number, saved card, vCard) ends up as the
# number on the sheet. Apple still shows its own sheet and asks for Face ID; nothing is sent silently.
import plistlib, uuid, sys, json
OUT, MODE = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "main")
U = lambda: str(uuid.uuid4()).upper()
u_src, u_dict, u_to, u_amt, u_note, u_amtx, u_c, g_if = (U() for _ in range(8))
ref = lambda uid, name, **extra: {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name, **extra}
att = lambda r: {"Value": r, "WFSerializationType": "WFTextTokenAttachment"}
tok = lambda parts: {"Value": {"string": "".join("￼" if isinstance(p, dict) else p for p in parts),
    "attachmentsByRange": {f"{{{sum(1 if isinstance(q, dict) else len(q) for q in parts[:i])}, 1}}": p for i, p in enumerate(parts) if isinstance(p, dict)}},
    "WFSerializationType": "WFTextTokenString"}
A = lambda ident, **p: {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p}
TEST = {"to": "+12147334408", "amt": "1.00", "note": "Friendly test"}
def pay(recipients, label=""):
  if MODE == "probe":
    return A("is.workflow.actions.output", WFOutput=tok([label, ": ", recipients["Value"], " $", ref(u_amtx, "Amount Text")]))
  p = dict(UUID=U(), ShowWhenRun=True, WFVenmoActionRecipients=recipients,
    WFVenmoActionAmount={"Value": {"Unit": "USD", "Magnitude": ref(u_amtx, "Amount Text")}, "WFSerializationType": "WFQuantityFieldValue"},
    WFVenmoActionNote=tok([ref(u_note, "Note")]))
  if MODE == "inapp": p["WFVenmoActionAppSwitch"] = True
  return A("is.workflow.actions.venmo.pay", **p)
acts = []
if MODE == "inapp":
  acts.append(A("is.workflow.actions.gettext", UUID=u_src, WFTextActionText=json.dumps(TEST)))
  src = att(ref(u_src, "Text"))
else:
  src = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}
D = att(ref(u_dict, "Dictionary"))
acts += [
  A("is.workflow.actions.detect.dictionary", UUID=u_dict, WFInput=src),
  A("is.workflow.actions.getvalueforkey", UUID=u_to, CustomOutputName="Number", WFDictionaryKey="to", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_amt, CustomOutputName="Amount", WFDictionaryKey="amt", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_note, CustomOutputName="Note", WFDictionaryKey="note", WFInput=D),
  A("is.workflow.actions.gettext", UUID=u_amtx, CustomOutputName="Amount Text", WFTextActionText=tok([ref(u_amt, "Amount")])),
]
if MODE in ("card", "probe"):
  acts += [
    A("is.workflow.actions.detect.contacts", UUID=u_c, CustomOutputName="Saved Contact", WFInput=att(ref(u_to, "Number"))),
    A("is.workflow.actions.conditional", GroupingIdentifier=g_if, WFControlFlowMode=0,
      WFConditions={"Value": {"WFActionParameterFilterPrefix": 1, "WFActionParameterFilterTemplates": [
        {"WFCondition": 100, "WFInput": {"Type": "Variable", "Variable": att(ref(u_c, "Saved Contact"))}}]},
        "WFSerializationType": "WFContentPredicateTableTemplate"}),
    pay(att(ref(u_c, "Saved Contact")), "CARD"),
    A("is.workflow.actions.conditional", GroupingIdentifier=g_if, WFControlFlowMode=1),
    pay(att(ref(u_to, "Number")), "NUMBER"),
    A("is.workflow.actions.conditional", GroupingIdentifier=g_if, WFControlFlowMode=2, UUID=U()),
  ]
else:
  acts.append(pay(att(ref(u_to, "Number"))))
if MODE in ("main", "card"):
  acts.append(A("is.workflow.actions.openapp", WFAppIdentifier="com.officialfriendly.app",
    WFSelectedApp={"BundleIdentifier": "com.officialfriendly.app", "Name": "Friendly", "TeamIdentifier": "L7H9872BR2"}))
wf = {"WFWorkflowClientVersion": "2607.0.2", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
  "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59446},
  "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
  "WFWorkflowInputContentItemClasses": ["WFStringContentItem"], "WFWorkflowHasShortcutInputVariables": MODE != "inapp",
  "WFWorkflowOutputContentItemClasses": ["WFStringContentItem"] if MODE == "probe" else [], "WFWorkflowHasOutputFallback": False,
  "WFWorkflowActions": acts}
plistlib.dump(wf, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("wrote", OUT, MODE, len(acts), "actions")
