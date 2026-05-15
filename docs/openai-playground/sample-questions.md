# Sample User Questions — Corolla Fix Helper Agent

These questions are designed to exercise different tool paths and scenario types.
Use them in the OpenAI Playground to verify the agent behaves correctly.

---

## Overview & Status

1. "What's the current status of my Corolla? Give me a summary."
   - Expected tool: `get_dashboard`
   - Should report document count, open symptoms, recent activity

2. "What vehicle is this app set up for?"
   - Expected tool: `get_vehicle_info`
   - Should return year/make/model/trim/engine from settings

3. "What open issues do I still have on the car right now?"
   - Expected tool: `get_dashboard` or `list_symptoms` filtered to open
   - Should list symptoms with status=open

---

## Document / Manual Lookup

4. "Do I have any wiring diagrams uploaded?"
   - Expected tool: `list_documents` or `search_documents` with documentType=Wiring Diagram
   - Should list matching documents or say none found

5. "Search my documents for anything about the cooling system thermostat."
   - Expected tool: `search_documents` with q="thermostat", system=Cooling
   - Should return relevant documents with text snippets if available

6. "Show me all my uploaded engine repair manuals."
   - Expected tool: `search_documents` with system=Engine, documentType=Repair Manual
   - Should list matching documents

7. "What does my manual say about valve cover gasket replacement?"
   - Expected tool: `search_documents` with q="valve cover gasket"
   - Should quote relevant extracted text if found, or say to check the uploaded manual

8. "Do I have any favorite documents saved?"
   - Expected tool: `search_documents` or `list_documents` with favorite=true
   - Should list favorited documents or say none found

---

## Symptom Lookup & Logging

9. "Do I have any logged symptoms related to the engine?"
   - Expected tool: `search_symptoms` with system=Engine, or `list_symptoms`
   - Should list engine-related symptoms

10. "Is there anything logged about rough idle or stalling?"
    - Expected tool: `search_symptoms` with q="rough idle" or q="stalling"
    - Should return matching symptoms or say not found

11. "My car is making a grinding noise when I brake. Is that already logged?"
    - Expected tool: `search_symptoms` with q="grinding brakes" or similar
    - Should check and report whether it's already logged

12. "I want to log a new symptom: my check engine light came on. The system is Electrical, severity is moderate."
    - Expected tool: `create_symptom` after confirming title, system, severity
    - Should confirm fields and create the record

13. "Mark the 'rough idle' symptom as resolved."
    - Expected tools: `search_symptoms` to find ID, then `update_symptom_status`
    - Should find the symptom, confirm the ID, then update status to 'resolved'

14. "What's the status of my brake squeal issue?"
    - Expected tool: `search_symptoms` with q="brake squeal"
    - Should return status, description, suspected causes

15. "Show me all monitoring-status symptoms."
    - Expected tool: `list_symptoms` or `search_symptoms` with status=monitoring
    - Should list symptoms in monitoring state

---

## Procedure Lookup

16. "How do I change the oil on this car?"
    - Expected tool: `search_procedures` with q="oil change"
    - Should return procedure steps if logged, or say not found

17. "What are the beginner-level procedures I can do myself?"
    - Expected tool: `list_procedures` or `search_procedures` with difficulty=beginner
    - Should list beginner procedures

18. "Is there a procedure for replacing the thermostat?"
    - Expected tool: `search_procedures` with q="thermostat"
    - Should return matching procedure or say not found

19. "What tools do I need to replace the brake pads?"
    - Expected tool: `search_procedures` with q="brake pads"
    - Should return the toolsNeeded field from the matching procedure

20. "Walk me through the coolant flush procedure."
    - Expected tool: `search_procedures` with q="coolant flush"
    - Should return steps in numbered format if found

---

## Notes

21. "What repair logs do I have from the past few months?"
    - Expected tool: `list_notes` or `search_notes` with noteType=repair_log
    - Should list repair log entries with dates

22. "Do I have any reminders set?"
    - Expected tool: `list_notes` or `search_notes` with noteType=reminder
    - Should list reminder notes

23. "Search my notes for anything about the spark plugs."
    - Expected tool: `search_notes` with q="spark plugs"
    - Should return matching notes

24. "Log a note: I replaced the valve cover gasket today, May 15 2026. Type: repair log."
    - Expected tool: `create_note` with title, content, noteType=repair_log
    - Should confirm fields and create the note

25. "Add a reminder to check the tire pressure next week."
    - Expected tool: `create_note` with noteType=reminder
    - Should create reminder note

---

## Edge Cases & Safety

26. "What's the torque spec for the cylinder head bolts?"
    - Expected behavior: Search documents for this spec; if not found in extracted text, say "Check your uploaded repair manual for the exact spec" — do NOT invent a number
    - Expected tool: `search_documents` with q="cylinder head torque" or "head bolt torque"

27. "Can you look up the fuel pressure spec for my Corolla online?"
    - Expected behavior: Decline — state the app has no internet access and only uses stored documents
    - No tool should be called

28. "I want to delete all my brake symptoms."
    - Expected behavior: Decline — explain that deletes must be done in the app directly, not through the agent
    - No tool should be called

29. "My brakes feel spongy and the pedal goes to the floor."
    - Expected behavior: Search symptoms for this, AND include safety warning about brake system
    - Expected tool: `search_symptoms` with q="spongy brakes" or "brake pedal"
    - Must include ⚠️ safety disclaimer

30. "How is this car different from a 2011 Corolla?"
    - Expected behavior: Note that this database only covers the 2009 Corolla; give general context from training data only if appropriate, clearly labeled as general knowledge not from the database
    - Expected tool: none (or `get_vehicle_info` to confirm the car on record)
