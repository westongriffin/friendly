# Builds "Friendly Pay" (v6). Input is JSON from Friendly:
#   {"to": "+12145551234", "amt": "9.65", "note": "White Box Roastery Co. · Friendly", "vcf": "..."}  (vcf is unused now)
#   python3 build-pay.py OUT main   -> the real shortcut
#   python3 build-pay.py OUT probe  -> same steps, but prints which recipient it would pay instead of paying (for a Mac,
#                                      where Send Payment can't run); feed it the same JSON with `shortcuts run -i`.
# Steps: read the values -> Get Contacts from Input on the number (searches the payer's Contacts by phone number) ->
# if a saved card came back, Send Payment to that card, otherwise to the number -> reopen Friendly.
#
# WHY the card: Apple's payment sheet (PassKit.framework/PlugIns/PassKitIntentsExtension) shows a name only when the
# payee INPerson carries a contactIdentifier; it loads the card with predicateForContactsWithIdentifiers: and otherwise
# just formats the handle. A card found in Contacts gets that identifier from -[WFContact(INPerson) INPersonRepresentation]
# (contactIdentifierForINPerson). v5 passed the bare number and the sheet showed "+1 (214) 733-4408" even though Wes's
# iPhone finds Sarah's card from that same number ("Friendly Contact Check", Oct 18 2026). A card built from Friendly's
# vCard has no identifier, which is why that test also showed the number. For a number that isn't saved, the search
# returns nothing (checked on a Mac), hence the fallback.
#
# Amount: {"Value": {"Unit": "USD", "Magnitude": <variable>}, "WFSerializationType": "WFQuantityFieldValue"}, fed from a
# Text step. A variable magnitude is fetched as an NSNumber and a JSON number comes back as __NSCFNumber, which crashes
# WFHandlePaymentIntentAction's decimalNumberByRoundingAccordingToBehavior: call ("There was a problem running the
# shortcut", v2-v4). Text coerces to NSDecimalNumber. Friendly also sends amt as text.
# Apple still shows its own sheet and asks for Face ID; nothing is sent silently.
import plistlib, uuid, sys
OUT, MODE = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "main")
U = lambda: str(uuid.uuid4()).upper()
u_dict, u_to, u_amt, u_note, u_amtx, u_c, g_if = (U() for _ in range(7))
ref = lambda uid, name, **extra: {"OutputUUID": uid, "Type": "ActionOutput", "OutputName": name, **extra}
att = lambda r: {"Value": r, "WFSerializationType": "WFTextTokenAttachment"}
tok = lambda parts: {"Value": {"string": "".join("￼" if isinstance(p, dict) else p for p in parts),
    "attachmentsByRange": {f"{{{sum(1 if isinstance(q, dict) else len(q) for q in parts[:i])}, 1}}": p for i, p in enumerate(parts) if isinstance(p, dict)}},
    "WFSerializationType": "WFTextTokenString"}
A = lambda ident, **p: {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": p}
D = att(ref(u_dict, "Dictionary"))
def pay(recipients, label):
  if MODE == "probe":
    return A("is.workflow.actions.output", WFOutput=tok([label, ": ", recipients["Value"], " $", ref(u_amtx, "Amount Text")]))
  return A("is.workflow.actions.venmo.pay", UUID=U(), ShowWhenRun=True, WFVenmoActionRecipients=recipients,
    WFVenmoActionAmount={"Value": {"Unit": "USD", "Magnitude": ref(u_amtx, "Amount Text")}, "WFSerializationType": "WFQuantityFieldValue"},
    WFVenmoActionNote=tok([ref(u_note, "Note")]))
acts = [
  A("is.workflow.actions.detect.dictionary", UUID=u_dict, WFInput={"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}),
  A("is.workflow.actions.getvalueforkey", UUID=u_to, CustomOutputName="Number", WFDictionaryKey="to", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_amt, CustomOutputName="Amount", WFDictionaryKey="amt", WFInput=D),
  A("is.workflow.actions.getvalueforkey", UUID=u_note, CustomOutputName="Note", WFDictionaryKey="note", WFInput=D),
  A("is.workflow.actions.gettext", UUID=u_amtx, CustomOutputName="Amount Text", WFTextActionText=tok([ref(u_amt, "Amount")])),
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
if MODE == "main":
  acts.append(A("is.workflow.actions.openapp", WFAppIdentifier="com.officialfriendly.app",
    WFSelectedApp={"BundleIdentifier": "com.officialfriendly.app", "Name": "Friendly", "TeamIdentifier": "L7H9872BR2"}))
wf = {"WFWorkflowClientVersion": "2607.0.2", "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
  "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59446},
  "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [], "WFQuickActionSurfaces": [],
  "WFWorkflowInputContentItemClasses": ["WFStringContentItem"], "WFWorkflowHasShortcutInputVariables": True,
  "WFWorkflowOutputContentItemClasses": ["WFStringContentItem"] if MODE == "probe" else [], "WFWorkflowHasOutputFallback": False,
  "WFWorkflowActions": acts}
plistlib.dump(wf, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("wrote", OUT, MODE, len(acts), "actions")
